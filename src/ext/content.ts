interface HotKey {
  code?: string;
  key?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

function callBridge(action: string, ...args) {
  browser.runtime.sendMessage({
    action: action,
    args: args,
  });
}

const bridge = {
  changeTabLeft: function() {
    callBridge("changeTabLeft");
  },
  changeTabRight: function() {
    callBridge("changeTabRight");
  },

  moveTabLeft: function() {
    callBridge("moveTabLeft");
  },
  moveTabRight: function() {
    callBridge("moveTabRight");
  },

  openTab: function(href: string) {
    callBridge("openTab", href);
  },

  setClipboard: function(txt: string) {
    const el = document.createElement("input");
    document.body.appendChild(el);
    el.value = txt;
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  },
};

let enabled = false;
let blacklisted = false;

browser.runtime.onMessage.addListener((obj) => {
  switch (obj.action) {
    case "enable":
      enabled = true;
      break;
    case "disable":
      enabled = false;
      break;
    default:
      console.error("Unknown action: " + obj.action);
  }
});

const defaultConf = {
  blacklist: "",
  scroll_speed: 0.3,
  scroll_speed_fast: 1.1,
  scroll_friction: 0.8,
  chars: ";alskdjfir",
  timer: 0,
  input_whitelist: [
    "checkbox",
    "radio",
    "hidden",
    "submit",
    "reset",
    "button",
    "file",
    "image",
  ],
  location_change_check_timeout: 2000,
  yt_fix_space: true,
};
const conf = defaultConf;

const defaultKeys = {
  scroll_up: "k",
  scroll_down: "l",
  scroll_up_fast: "<Shift>_",
  scroll_down_fast: "<Shift>+",
  blobs_show: "h",
  blobs_hide: "Escape",
  blobs_click: "Enter",
  blobs_click_new_tab: "<Shift>Enter",
  blobs_click_clipboard: "<Control>Enter",
  blobs_focus: "Tab",
  blobs_backspace: "Backspace",
  elem_deselect: "Escape",
  change_tab_left: "j",
  change_tab_right: ";",
  move_tab_left: "<Shift>J",
  move_tab_right: "<Shift>:",
  history_back: "<Control>j",
  history_forward: "<Control>;",
};
const keys = {};

browser.storage.local.get(["keys", "conf"]).then((obj) => {
  // Get keys
  const keyNames = Object.keys(defaultKeys);
  if (obj.keys === undefined) obj.keys = {};
  for (const i in keyNames) {
    const name = keyNames[i];
    interpretKey(name, obj.keys[name] || defaultKeys[name]);
  }

  // Get conf
  const confNames = Object.keys(defaultConf);
  if (obj.conf === undefined) obj.conf = {};
  for (const i in confNames) {
    const name = confNames[i];
    conf[name] = obj.conf[name] == null ? defaultConf[name] : obj.conf[name];
  }

  // Is this URL blacklisted?
  const rxes = conf.blacklist.split("\n").filter((x) => x.trim() !== "");
  for (const i in rxes) {
    const rx = new RegExp(rxes[i].trim());
    if (rx.test(location.href)) {
      blacklisted = true;
      break;
    }
  }
});

function interpretKey(name: string, k: string) {
  const key: HotKey = {};

  const matches = k.match(/<.*>/g);
  for (const i in matches) {
    const m = matches[i].replace("<", "").replace(">", "").trim().toLowerCase();

    if (m === "control") key.ctrlKey = true;
    else if (m === "shift") key.shiftKey = true;
    else if (m === "alt") key.altKey = true;
    else if (m === "meta") key.metaKey = true;
    else console.error("Unknown modifier:", m);
  }

  key.code = k.replace(/<.*?>/g, "").trim();

  keys[name] = key;
}

function isMatch(k: HotKey, evt: HotKey) {
  if (
    k.code === evt.key &&
    !!k.ctrlKey == evt.ctrlKey &&
    !!k.shiftKey == evt.shiftKey &&
    !!k.altKey == evt.altKey &&
    !!k.metaKey == evt.metaKey
  ) {
    return true;
  }

  return false;
}

//There's a lot we don't want to do if we're not on an actual webpage, but on
//the "speed dial"-ish pages.
const onWebPage = document.body !== undefined;

function createKey(n: number) {
  let str = "";
  const base = conf.chars.length;

  if (n == 0) return conf.chars[0];

  while (n > 0) {
    str += conf.chars[n % base];
    n = Math.floor(n / base);
  }

  return str;
}

function getElemPos(el: HTMLElement) {
  let curtop = 0;
  let curleft = 0;

  do {
    curtop += el.offsetTop;
    curleft += el.offsetLeft;
  } while ((el = el.offsetParent as HTMLElement));

  return { top: curtop, left: curleft };
}

const blobList = {
  blobs: {},
  container: null,
  overview: null,

  visible: false,
  needLoadBlobs: true,

  currentKey: "",

  createContainer: function() {
    const container = document.createElement("div");
    container.style = [
      "pointer-events: none",
      "display: none",
      "position: absolute;",
      "top: 0px",
      "left: 0px",
      "z-index: 2147483647",
      "box-sizing: content-box",
      "",
    ].join(" !important;");
    document.body.appendChild(container);
    blobList.container = container;
  },

  createOverview: function() {
    const overview = document.createElement("div");
    overview.style = [
      "position: fixed",
      "top: 0px",
      "left: 0px",
      "background-color: white",
      "border-bottom: 2px solid black",
      "border-right: 2px solid black",
      "color: black",
      "font: 12px sans-serif",
      "padding: 3px",
      "height: 15px",
      "line-height: 15px",
      "z-index: 2147483647",
      "box-sizing: content-box",
      "",
    ].join(" !important;");
    blobList.container.appendChild(overview);
    blobList.overview = overview;
  },

  init: function() {
    if (!onWebPage) return;

    blobList.createContainer();

    window.addEventListener("scroll", function() {
      blobList.needLoadBlobs = true;
    });
  },

  currentIndex: 0,
  loadBlobs: function() {
    if (!onWebPage) return;

    const linkElems = document.querySelectorAll<HTMLElement>(
      "a, button, input, select, textarea, summary, [role='button'], [tabindex='0']"
    );

    //Remove old container contents
    blobList.container.innerText = "";
    blobList.createOverview();

    //Remove old blobs
    blobList.blobs = {};

    let i = 0;
    let nRealBlobs = 0;
    function addBlob() {
      const linkElem = linkElems[i];

      if (i++ >= linkElems.length) return false;

      if (linkElem === undefined) return true;

      //We don't want hidden elements
      if (
        linkElem === undefined ||
        linkElem.style.display == "none" ||
        linkElem.style.visibility == "hidden"
      ) {
        return true;
      }

      //Get element's absolute position
      const pos = getElemPos(linkElem);

      //Lots of things which don't really exist have an X and Y value of 0
      if (pos.top == 0 && pos.left == 0) return true;

      //We don't need to get things far above our current scroll position
      if (pos.top < window.scrollY - 100) return true;

      //We don't need things below our scroll position either
      if (pos.top - 100 > window.scrollY + window.innerHeight) return true;

      //Create the blob's key
      const key = createKey(nRealBlobs);
      nRealBlobs += 1;

      const blobElem = document.createElement("div");
      blobElem.innerText = key.toUpperCase();
      blobElem.style = [
        "position: absolute",
        "background-color: yellow",
        "border: 1px solid black",
        "border-radius: 10px",
        "padding-left: 3px",
        "padding-right: 3px",
        "color: black",
        "font: 12px sans-serif",
        "top: " + pos.top + "px",
        "left: " + pos.left + "px",
        "line-height: 13px",
        "font-size: 12px",
        "",
      ].join(" !important;");
      blobList.container.appendChild(blobElem);

      blobList.blobs[key] = {
        blobElem: blobElem,
        linkElem: linkElem,
      };

      return true;
    }

    while (addBlob()) { }
  },

  showBlobs: function() {
    blobList.visible = true;
    blobList.container.style.display = "block";
  },

  hideBlobs: function() {
    blobList.currentKey = "";
    blobList.visible = false;
    blobList.container.style.display = "none";
  },

  click: function() {
    if (!blobList.visible) return;

    const blob = blobList.blobs[blobList.currentKey];
    if (!blob) return;

    if (
      blob.linkElem.tagName == "A" &&
      blob.linkElem.href &&
      blob.linkElem.href.indexOf("javascript") != 0
    ) {
      blobList.hideBlobs();
      blob.linkElem.focus();
      location.href = blob.linkElem.href;
    } else {
      blobList.hideBlobs();
      blob.linkElem.click();
      blob.linkElem.focus();
    }
  },

  clickNewTab: function() {
    if (!blobList.visible) return;

    const blob = blobList.blobs[blobList.currentKey];
    if (!blob) return;

    blobList.hideBlobs();
    if (blob.linkElem.tagName == "A" && blob.linkElem.href) {
      bridge.openTab(blob.linkElem.href);
    } else {
      blob.linkElem.click();
      blob.linkElem.focus();
    }
  },

  clickClipboard: function() {
    if (!blobList.visible) return;

    const blob = blobList.blobs[blobList.currentKey];
    if (!blob) return;

    if (!blob.linkElem.href) return;

    bridge.setClipboard(blob.linkElem.href);

    blobList.hideBlobs();
  },

  focus: function() {
    if (!blobList.visible) return;

    const blob = blobList.blobs[blobList.currentKey];
    if (!blob) return;

    blobList.hideBlobs();
    blob.linkElem.focus();
  },

  appendKey: function(c: string) {
    blobList.currentKey += c;
    blobList.overview.innerText = blobList.currentKey;
  },

  backspace: function() {
    blobList.currentKey = blobList.currentKey.substring(
      0,
      blobList.currentKey.length - 1
    );
    blobList.overview.innerText = blobList.currentKey;
  },
};
blobList.init();

//Reload blobs whenever the URL changes
let currentUrl = location.href;
setInterval(function() {
  if (currentUrl !== location.href) {
    blobList.loadBlobs();
  }
  currentUrl = location.href;
}, conf.location_change_check_timeout);

// const pressedKeys = [];

function isValidElem(el: HTMLButtonElement) {
  const tag = el.tagName.toLowerCase();

  if (tag === "textarea") return false;

  if (tag === "select") return false;

  if (tag === "canvas") return false;

  if (el.contentEditable.toLowerCase() === "true") return false;

  if (
    tag === "input" &&
    conf.input_whitelist.indexOf(el.type.toLowerCase()) === -1
  ) {
    return false;
  }

  return true;
}

window.addEventListener(
  "keydown",
  function(evt) {
    if (!enabled || blacklisted) return;
    if (/about:.+/.test(location.href)) return;

    const active = document.activeElement as HTMLButtonElement;

    //We don't want to do anything if the user is typing in an input field,
    //unless the key is to deselect an input field
    if (!isValidElem(active)) {
      if (isMatch(keys.elem_deselect, evt)) {
        active.blur();
        setTimeout(() => active.blur(), 50); // In case something tries to refocus
        blobList.hideBlobs();
        return;
      } else {
        return;
      }
    }

    //User is typing a key to a blob
    if (blobList.visible) {
      evt.preventDefault();
      evt.stopPropagation();

      //Hide blobs if appropriate
      //Escape key always hides blobs if visible
      if (evt.which === 27 || isMatch(keys.blobs_hide, evt)) {
        blobList.hideBlobs();
        return;
      }

      //Backspace if appropriate
      if (isMatch(keys.blobs_backspace, evt)) {
        blobList.backspace();

        //Stop auto-submit timeout
        if (timer) {
          clearTimeout(timer);
          timer = 0;
        }

        return;
      }

      const c = evt.key;
      if (conf.chars.indexOf(c) !== -1) {
        blobList.appendKey(c);

        //Reset auto-submit timeout
        if (timer) {
          clearTimeout(timer);
        }
        if (conf.timer > 0) {
          timer = this.setTimeout(blobList.click, conf.timer);
        }

        return false;
      }
    }

    //Handle other key presses

    //Deselect element
    if (onWebPage && isMatch(keys.elem_deselect, evt)) {
      blobList.hideBlobs();
      active.blur();

      //Show/hide/reload blobs
    } else if (
      onWebPage &&
      !blobList.visible &&
      isMatch(keys.blobs_show, evt)
    ) {
      blobList.loadBlobs();
      blobList.needLoadBlobs = false;
      blobList.showBlobs();
    } else if (onWebPage && blobList.visible && isMatch(keys.blobs_hide, evt)) {
      blobList.hideBlobs();

      //Simulate clicks
    } else if (
      onWebPage &&
      blobList.visible &&
      isMatch(keys.blobs_click, evt)
    ) {
      blobList.click();
    } else if (
      onWebPage &&
      blobList.visible &&
      isMatch(keys.blobs_click_new_tab, evt)
    ) {
      blobList.clickNewTab();
    } else if (
      onWebPage &&
      blobList.visible &&
      isMatch(keys.blobs_click_clipboard, evt)
    ) {
      blobList.clickClipboard();

      //Focus element
    } else if (
      onWebPage &&
      blobList.visible &&
      isMatch(keys.blobs_focus, evt)
    ) {
      blobList.focus();

      //Scrolling
    } else if (onWebPage && isMatch(keys.scroll_up, evt)) {
      scroll.start(-conf.scroll_speed);
    } else if (onWebPage && isMatch(keys.scroll_down, evt)) {
      scroll.start(conf.scroll_speed);
    } else if (onWebPage && isMatch(keys.scroll_up_fast, evt)) {
      scroll.start(-conf.scroll_speed_fast);
    } else if (onWebPage && isMatch(keys.scroll_down_fast, evt)) {
      scroll.start(conf.scroll_speed_fast);

      //Back and forwards
    } else if (isMatch(keys.history_back, evt)) {
      history.back();
    } else if (isMatch(keys.history_forward, evt)) {
      history.forward();

      //Change tab
    } else if (isMatch(keys.change_tab_left, evt)) {
      bridge.changeTabLeft();
    } else if (isMatch(keys.change_tab_right, evt)) {
      bridge.changeTabRight();

      //Move tab
    } else if (isMatch(keys.move_tab_left, evt)) {
      bridge.moveTabLeft();
    } else if (isMatch(keys.move_tab_right, evt)) {
      bridge.moveTabRight();

      //Fix youtube space by emulating clicking the player
    } else if (
      conf.yt_fix_space &&
      /youtube\.com/.test(location.host) &&
      location.pathname.indexOf("/watch") === 0 &&
      evt.keyCode === 32
    ) {
      document.getElementById("movie_player")!.click();

      //We don't want to stop the event from propagating
      //if it hasn't matched anything yet
    } else {
      return true;
    }

    evt.preventDefault();
    evt.stopPropagation();
    return false;
  },
  true
);

window.addEventListener(
  "keyup",
  function(evt) {
    if (
      isMatch(keys.scroll_up, evt) ||
      isMatch(keys.scroll_down, evt) ||
      isMatch(keys.scroll_up_fast, evt) ||
      isMatch(keys.scroll_down_fast, evt)
    ) {
      scroll.stop();
    }
  },
  true
);

let scroll = {
  start: function(acceleration: number) {
    scroll.acceleration = acceleration;

    if (scroll.raf == null) scroll.update();
  },

  stop: function() {
    scroll.acceleration = 0;
  },

  update: function() {
    const tdiff = scroll.endTime - scroll.startTime;
    if (tdiff < 100) {
      scroll.velocity += scroll.acceleration;
      window.scrollBy(0, scroll.velocity * tdiff);
      scroll.velocity *= conf.scroll_friction;
    }

    if (tdiff < 100 && scroll.velocity > -0.1 && scroll.velocity < 0.1) {
      scroll.velocity = 0;
      cancelAnimationFrame(scroll.raf);
      scroll.raf = null;
    } else {
      scroll.startTime = scroll.endTime;
      scroll.endTime = new Date().getTime();
      scroll.raf = requestAnimationFrame(scroll.update);
    }
  },

  raf: null,
  acceleration: 0,
  velocity: 0,
  startDate: 0,
  endDate: 0,
};

let timer = false;