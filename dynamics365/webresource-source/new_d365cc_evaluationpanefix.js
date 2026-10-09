// Conversation Form fixes for opening a conversation inside another site (e.g. the Salesforce recording pop-up).
//
// 1. "Error loading control" in the Evaluation Details side pane (MscrmControls.OC.OCEvaluationDetailsControl).
//    The control's bundle references the Fluent UI v8 platform library (global FluentUIReact) without declaring it,
//    so it only works in apps where some other control happened to load Fluent v8 first (e.g. the multisession workspace).
//    This script loads Fluent v8 from the same Power Apps CDN the platform uses, then re-registers the control if it already failed.
//
// 2. Empty Transcript tab when Dynamics 365 is embedded in another site.
//    Microsoft's transcript loader (msdyn_ChatControl.htm) starts by reading window.top.Xrm. When the top window belongs to
//    another site the browser blocks that read, the loader stops, and the Transcript tab stays blank. In that case only,
//    this script reads the conversation's transcript and renders it in the same place. Opened directly in Dynamics 365,
//    Microsoft's control is left untouched.
var D365CC = D365CC || {};
D365CC.EvaluationPaneFix = (function () {
  var PANE_ID = "EvaluationDetailsSidePane";
  var CONTROL_BUNDLE = "cc_MscrmControls.OC.OCEvaluationDetailsControl/bundle.js";
  var FALLBACK_VERSION = "1.4.12422-2608.4";

  function hostWindow() {
    // Form scripts run inside the same-origin ClientApiFrame; the side pane and platform libraries live in its parent.
    try { if (window.parent && window.parent !== window && window.parent.document && window.parent.Xrm && window.parent.Xrm.App) { return window.parent; } } catch (e) { }
    return window;
  }

  function fluentUrl(w) {
    var scripts = w.document.scripts, base = "https://content.powerapps.com/resource/uci-infra-web/", ver = null;
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].src || "";
      var m = s.match(/^(https:\/\/[^\/]+\/resource\/uci-infra-web\/)controlsAssets\/([^\/]+)\/platformlibs\//);
      if (m) { base = m[1]; ver = m[2]; break; }
      var c = s.match(/cdnEndpointCheck\.js\?v=([^&]+)/);
      if (c && !ver) { ver = c[1]; }
      var b = s.match(/^(https:\/\/[^\/]+\/resource\/uci-infra-web\/)/);
      if (b) { base = b[1]; }
    }
    return base + "controlsAssets/" + (ver || FALLBACK_VERSION) + "/platformlibs/fluent/8.29.0/fluent_8_29_0.js";
  }

  function ensureFluent(w) {
    if (w.FluentUIReact) { return Promise.resolve(false); }
    if (w.__d365ccFluentPromise) { return w.__d365ccFluentPromise; }
    w.__d365ccFluentPromise = new Promise(function (resolve) {
      var alias = function () { if (!w.FluentUIReact && w.FluentUIReactv8290) { w.FluentUIReact = w.FluentUIReactv8290; } };
      var inject = function () {
        alias();
        if (w.FluentUIReact) { resolve(true); return; }
        var el = w.document.createElement("script");
        el.src = fluentUrl(w);
        el.onload = function () { alias(); resolve(!!w.FluentUIReact); };
        el.onerror = function () { resolve(false); };
        w.document.head.appendChild(el);
      };
      // The Fluent v8 UMD binds to the React/ReactDOM globals at load time, so wait until the platform has exposed them.
      var tries = 0;
      var wait = w.setInterval(function () {
        tries++;
        if ((w.React && w.ReactDOM) || tries > 120) { w.clearInterval(wait); inject(); }
      }, 100);
    });
    return w.__d365ccFluentPromise;
  }

  function paneFailed(w) {
    try {
      if (!w.Xrm.App.sidePanes.getPane(PANE_ID)) { return false; }
      var host = w.document.querySelector('[id*="' + PANE_ID + '"]') || w.document.body;
      return (host.innerText || "").indexOf("Error loading control") >= 0;
    } catch (e) { return false; }
  }

  function bundleUrl(w) {
    try {
      var e = w.performance.getEntriesByType("resource");
      for (var i = e.length - 1; i >= 0; i--) { if (e[i].name.indexOf(CONTROL_BUNDLE) >= 0) { return e[i].name; } }
    } catch (x) { }
    return w.location.origin + "/webresources/" + CONTROL_BUNDLE;
  }

  function repair(w, formContext) {
    w.__d365ccEvalRepairs = (w.__d365ccEvalRepairs || 0) + 1;
    if (w.__d365ccEvalRepairs > 2) { return; }
    w.fetch(bundleUrl(w), { credentials: "same-origin" }).then(function (r) { return r.text(); }).then(function (src) {
      (0, w.eval)(src);
      var pane = w.Xrm.App.sidePanes.getPane(PANE_ID);
      return (pane ? pane.close() : Promise.resolve()).then(function () {
        var e = formContext.data.entity;
        w.Xrm.Navigation.navigateTo({ pageType: "entityrecord", entityName: e.getEntityName(), entityId: e.getId().replace(/[{}]/g, "") });
      });
    }).catch(function () { });
  }

  return {
    onLoad: function (executionContext) {
      var w = hostWindow();
      var formContext = executionContext && executionContext.getFormContext ? executionContext.getFormContext() : null;
      if (!w || !w.document) { return; }
      try { D365CC.EmbeddedTranscript.start(w, formContext); } catch (e) { }
      ensureFluent(w).then(function () {
        if (!w.FluentUIReact || !formContext) { return; }
        var started = Date.now();
        var timer = w.setInterval(function () {
          if (paneFailed(w)) { w.clearInterval(timer); repair(w, formContext); }
          else if (Date.now() - started > 30000) { w.clearInterval(timer); }
        }, 500);
      });
    }
  };
})();

D365CC.EmbeddedTranscript = (function () {
  var FRAME_PREFIX = "ConversationControlTransciptIframe-";
  var MARK = "data-d365cc-transcript";
  var EMPTY_GRACE_MS = 2500;
  var SEARCH_BOX = '[data-test-id="search-transcript-button"]';
  var DOWNLOAD_BUTTON = '[data-test-id="download-transcript-button"]';

  function embeddedInOtherSite(w) {
    try { return !w.top.location.href; } catch (e) { return true; }
  }

  function getJson(w, url) {
    return w.fetch(url, { credentials: "same-origin", headers: { "Accept": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" } })
      .then(function (r) { if (!r.ok) { throw new Error("HTTP " + r.status); } return r.json(); });
  }

  function decodeBase64Utf8(b64) {
    var bin = atob(b64 || ""), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return new TextDecoder("utf-8").decode(bytes);
  }

  function rawMessages(fileText) {
    var parsed = JSON.parse(fileText), out = [];
    var list = Array.isArray(parsed) ? parsed : [parsed];
    list.forEach(function (entry) {
      if (!entry) { return; }
      if (entry.created || entry.createdDateTime) { out.push(entry); return; }
      var content = entry.Content;
      try { content = typeof content === "string" ? JSON.parse(content) : content; } catch (e) { content = null; }
      if (Array.isArray(content)) { out = out.concat(content); }
    });
    return out;
  }

  function plainText(w, html) {
    var s = String(html == null ? "" : html);
    if (s.indexOf("<") < 0 && s.indexOf("&") < 0) { return s.trim(); }
    var doc = new w.DOMParser().parseFromString(s, "text/html");
    return (doc.body ? doc.body.textContent : "").trim();
  }

  function normalize(w, m) {
    if (!m || m.isControlMessage || m.deleted) { return null; }
    var tags = String(m.tags || "").toLowerCase().split(",").map(function (t) { return t.trim(); });
    var has = function (t) { return tags.indexOf(t) >= 0; };
    // OCInternalEvent entries are internal copies (e.g. translations) of messages that are already in the transcript.
    if (has("ocinternalevent")) { return null; }
    var text = plainText(w, m.content);
    if (!text) { return null; }
    var from = m.from || {}, who = from.user || from.application || {};
    var role = has("system") ? "system" : has("frombotagent") ? "bot" : (m.isFromAgent || from.user) ? "agent" : "customer";
    var name = role === "customer" ? "Customer" : role === "system" ? "" : (who.displayName || (role === "bot" ? "Bot" : "Agent"));
    var time = new Date(m.created || m.createdDateTime);
    return { role: role, name: name, text: text, time: time, id: String(m.id || "") };
  }

  function loadTranscript(w, conversationId) {
    var api = w.Xrm.Utility.getGlobalContext().getClientUrl() + "/api/data/v9.2/";
    return getJson(w, api + "msdyn_transcripts?$select=msdyn_transcriptid&$filter=_msdyn_liveworkitemidid_value eq " + conversationId)
      .then(function (t) {
        var ids = (t.value || []).map(function (x) { return x.msdyn_transcriptid; });
        if (!ids.length) { return { value: [] }; }
        var filter = ids.map(function (id) { return "_objectid_value eq " + id; }).join(" or ");
        return getJson(w, api + "annotations?$select=documentbody&$filter=isdocument eq true and (" + filter + ")");
      })
      .then(function (a) {
        var messages = [];
        (a.value || []).forEach(function (note) {
          try { messages = messages.concat(rawMessages(decodeBase64Utf8(note.documentbody))); } catch (e) { }
        });
        var seen = {};
        return messages.map(function (m) { return normalize(w, m); })
          .filter(function (m) {
            if (!m || isNaN(m.time.getTime())) { return false; }
            var key = m.id + "|" + m.role + "|" + m.text;
            if (seen[key]) { return false; }
            seen[key] = true;
            return true;
          })
          .sort(function (x, y) { return x.time - y.time || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0); });
      });
  }

  function timeFormatter(w) {
    var offset = null, locale;
    try {
      var us = w.Xrm.Utility.getGlobalContext().userSettings;
      offset = us.getTimeZoneOffsetMinutes();
    } catch (e) { }
    try { locale = w.navigator.language; } catch (e) { }
    var fmt;
    try { fmt = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: offset == null ? undefined : "UTC" }); }
    catch (e) { fmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }); }
    return function (d) { return fmt.format(offset == null ? d : new Date(d.getTime() + offset * 60000)); };
  }

  function elapsed(ms) {
    var s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    s = s % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return (h ? h + ":" + pad(m) : pad(m)) + ":" + pad(s);
  }

  var CSS = [
    "html,body{margin:0;height:100%;font-family:'Segoe UI','Segoe UI Web (West European)',-apple-system,BlinkMacSystemFont,Roboto,'Helvetica Neue',sans-serif;font-size:14px;color:#242424;background:#fff}",
    ".tx{display:flex;flex-direction:column;height:100%}",
    ".tx-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e0e0e0;background:#fafafa}",
    ".tx-bar input{flex:1;max-width:320px;height:30px;padding:0 10px;border:1px solid #8a8886;border-radius:4px;font:inherit}",
    ".tx-bar input:focus{outline:2px solid #0f6cbd;outline-offset:-1px;border-color:transparent}",
    ".tx-count{color:#616161;font-size:12px}",
    ".tx-list{flex:1;overflow-y:auto;padding:12px 16px 24px}",
    ".tx-msg{display:flex;gap:8px;margin:12px 0;align-items:flex-start}",
    ".tx-msg.out{flex-direction:row-reverse}",
    ".tx-av{flex:0 0 32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;background:#0f6cbd}",
    ".tx-msg.bot .tx-av{background:#5b5fc7}.tx-msg.agent .tx-av{background:#107c10}",
    ".tx-body{max-width:75%;display:flex;flex-direction:column}",
    ".tx-msg.out .tx-body{align-items:flex-end}",
    ".tx-meta{font-size:12px;color:#616161;margin:0 2px 4px}",
    ".tx-meta b{font-weight:600;color:#424242;margin-right:6px}",
    ".tx-text{padding:8px 12px;border-radius:6px;background:#f5f5f5;line-height:20px;white-space:pre-wrap;word-break:break-word}",
    ".tx-msg.out .tx-text{background:#ebf3fc}",
    ".tx-sys{text-align:center;margin:12px 0;font-size:12px;color:#616161}",
    ".tx-sys span{display:inline-block;padding:2px 10px;border-radius:10px;background:#f0f0f0}",
    ".tx-empty{padding:32px 16px;text-align:center;color:#616161}",
    "mark{background:#fff100;color:inherit;padding:0}",
    ".tx-hide{display:none}"
  ].join("\n");

  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) { e.className = cls; }
    if (text != null) { e.textContent = text; }
    return e;
  }

  function initials(name) {
    var p = String(name || "").replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
    return ((p[0] || "?").charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : "")).toUpperCase();
  }

  function setHighlighted(doc, node, text, term) {
    node.textContent = "";
    if (!term) { node.textContent = text; return; }
    var lower = text.toLowerCase(), i = 0, j;
    while ((j = lower.indexOf(term, i)) >= 0) {
      if (j > i) { node.appendChild(doc.createTextNode(text.slice(i, j))); }
      node.appendChild(el(doc, "mark", null, text.slice(j, j + term.length)));
      i = j + term.length;
    }
    if (i < text.length) { node.appendChild(doc.createTextNode(text.slice(i))); }
  }

  function render(w, doc, messages, ownSearch) {
    var fmt = timeFormatter(w), start = messages.length ? messages[0].time.getTime() : 0;
    doc.head.appendChild(el(doc, "style", null, CSS));
    doc.body.textContent = "";
    doc.body.setAttribute(MARK, "1");
    var root = el(doc, "div", "tx"), list = el(doc, "div", "tx-list"), search = null, count = null;
    list.setAttribute("role", "log");
    list.setAttribute("aria-label", "Conversation transcript");
    if (ownSearch) {
      var bar = el(doc, "div", "tx-bar");
      search = el(doc, "input");
      search.type = "search";
      search.placeholder = "Search transcript";
      search.setAttribute("aria-label", "Search transcript");
      count = el(doc, "span", "tx-count");
      bar.appendChild(search);
      bar.appendChild(count);
      root.appendChild(bar);
    }
    root.appendChild(list);
    doc.body.appendChild(root);

    var rows = [];
    var spoken = messages.filter(function (m) { return m.role !== "system"; }).length;
    var total = spoken + (spoken === 1 ? " message" : " messages");
    if (count) { count.textContent = total; }
    if (!messages.length) {
      list.appendChild(el(doc, "div", "tx-empty", "There is no transcript for this conversation yet."));
      if (search) { search.disabled = true; }
      return { filter: function () { } };
    }
    messages.forEach(function (m) {
      var stamp = fmt(m.time) + " \u00b7 " + elapsed(m.time.getTime() - start);
      if (m.role === "system") {
        var sys = el(doc, "div", "tx-sys"), pill = el(doc, "span");
        pill.title = stamp;
        sys.appendChild(pill);
        list.appendChild(sys);
        rows.push({ row: sys, textNode: pill, text: m.text });
        setHighlighted(doc, pill, m.text, "");
        return;
      }
      var row = el(doc, "div", "tx-msg " + m.role + (m.role === "customer" ? "" : " out"));
      var body = el(doc, "div", "tx-body"), meta = el(doc, "div", "tx-meta"), text = el(doc, "div", "tx-text");
      row.appendChild(el(doc, "div", "tx-av", m.role === "customer" ? "C" : initials(m.name)));
      meta.appendChild(el(doc, "b", null, m.name));
      meta.appendChild(doc.createTextNode(stamp));
      body.appendChild(meta);
      body.appendChild(text);
      row.appendChild(body);
      list.appendChild(row);
      setHighlighted(doc, text, m.text, "");
      rows.push({ row: row, textNode: text, text: m.text });
    });

    var filter = function (value) {
      var term = String(value || "").trim().toLowerCase(), hits = 0, first = null;
      rows.forEach(function (r) {
        var match = !term || r.text.toLowerCase().indexOf(term) >= 0;
        r.row.classList.toggle("tx-hide", !match);
        setHighlighted(doc, r.textNode, r.text, match ? term : "");
        if (match && term) { hits++; first = first || r.row; }
      });
      if (count) { count.textContent = term ? hits + (hits === 1 ? " match" : " matches") : total; }
      if (first) { first.scrollIntoView({ block: "nearest" }); }
    };
    if (search) { search.addEventListener("input", function () { filter(search.value); }); }
    return { filter: filter };
  }

  function renderError(doc) {
    doc.body.textContent = "";
    doc.body.setAttribute(MARK, "1");
    doc.head.appendChild(el(doc, "style", null, CSS));
    doc.body.appendChild(el(doc, "div", "tx-empty", "The transcript couldn't be loaded here. Use \"Open in a new tab\" to view it directly in Dynamics 365."));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; });
  }

  function download(w, state, messages) {
    var fmt = timeFormatter(w), start = messages.length ? messages[0].time.getTime() : 0;
    var rows = messages.map(function (m) {
      var who = m.role === "system" ? "" : "<b>" + escapeHtml(m.name) + "</b> ";
      return "<p><span style=\"color:#616161\">" + escapeHtml(fmt(m.time) + " \u00b7 " + elapsed(m.time.getTime() - start)) + "</span><br>" + who + escapeHtml(m.text) + "</p>";
    });
    var html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Transcript</title></head>" +
      "<body style=\"font-family:'Segoe UI',sans-serif;font-size:14px\"><h2>Transcript</h2><p style=\"color:#616161\">Conversation ID: " +
      escapeHtml(state.id) + "</p>" + rows.join("") + "</body></html>";
    var url = w.URL.createObjectURL(new w.Blob([html], { type: "text/html" }));
    var a = w.document.createElement("a");
    a.href = url;
    a.download = "Transcript.html";
    w.document.body.appendChild(a);
    a.click();
    a.remove();
    w.setTimeout(function () { w.URL.revokeObjectURL(url); }, 10000);
  }

  function toolbarOf(frame) {
    for (var e = frame, k = 0; e && k < 8; k++) {
      e = e.parentElement;
      if (e && e.querySelector(SEARCH_BOX)) { return e; }
    }
    return null;
  }

  function fallbackActive(w, state, target) {
    var frame = w.document.getElementById(FRAME_PREFIX + state.id), bar = frame && toolbarOf(frame);
    if (!bar || !bar.contains(target)) { return false; }
    try { return frame.contentDocument.body.getAttribute(MARK) === "1"; } catch (e) { return false; }
  }

  // Microsoft's Search box and Download transcript button talk to the control inside the iframe, so they do nothing
  // when the fallback is shown. Listeners are delegated from the document so they survive React re-rendering the toolbar.
  function hookToolbar(w, state) {
    if (w.__d365ccTranscriptHooks) {
      w.document.removeEventListener("input", w.__d365ccTranscriptHooks.input, true);
      w.document.removeEventListener("click", w.__d365ccTranscriptHooks.click, true);
    }
    var hooks = {
      input: function (e) {
        var box = e.target && e.target.closest && e.target.closest(SEARCH_BOX);
        if (box && state.view && fallbackActive(w, state, box)) { state.view.filter(box.value); }
      },
      click: function (e) {
        var btn = e.target && e.target.closest && e.target.closest(DOWNLOAD_BUTTON);
        if (!btn || !state.data || !fallbackActive(w, state, btn)) { return; }
        e.preventDefault();
        e.stopPropagation();
        state.data.then(function (messages) { download(w, state, messages); });
      }
    };
    w.document.addEventListener("input", hooks.input, true);
    w.document.addEventListener("click", hooks.click, true);
    w.__d365ccTranscriptHooks = hooks;
  }

  function check(w, state) {
    var frame = w.document.getElementById(FRAME_PREFIX + state.id);
    if (!frame) { state.emptySince = 0; return; }
    var doc;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.body || doc.readyState !== "complete" || doc.body.hasAttribute(MARK)) { return; }
    // Microsoft's loader replaces the body with its control when it works; only step in while it stays empty.
    if (doc.body.children.length > 0 || (doc.body.textContent || "").trim()) { state.emptySince = 0; return; }
    if (!state.emptySince || state.doc !== doc) { state.emptySince = Date.now(); state.doc = doc; return; }
    if (Date.now() - state.emptySince < EMPTY_GRACE_MS) { return; }
    doc.body.setAttribute(MARK, "loading");
    state.data = state.data || loadTranscript(w, state.id);
    state.data.then(function (messages) {
      var bar = toolbarOf(frame), box = bar && bar.querySelector(SEARCH_BOX);
      state.view = render(w, doc, messages, !box);
      if (box && box.value) { state.view.filter(box.value); }
    }, function () { renderError(doc); });
  }

  return {
    start: function (w, formContext) {
      if (!formContext || !embeddedInOtherSite(w)) { return; }
      var entity = formContext.data && formContext.data.entity;
      if (!entity || entity.getEntityName() !== "msdyn_ocliveworkitem") { return; }
      var id = entity.getId().replace(/[{}]/g, "").toLowerCase();
      if (!id) { return; }
      if (w.__d365ccTranscriptWatch) { w.clearInterval(w.__d365ccTranscriptWatch); }
      var state = { id: id, emptySince: 0, data: null, doc: null, view: null };
      hookToolbar(w, state);
      w.__d365ccTranscriptWatch = w.setInterval(function () { try { check(w, state); } catch (e) { } }, 1000);
    }
  };
})();