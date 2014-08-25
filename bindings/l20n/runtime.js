'use strict';

/* global Entity, Locale, Context, L10nError */
/* global getPluralRule, rePlaceables, PropertiesParser, compile */
/* global translateDocument, io */
/* global translateFragment, localizeElement, translateElement */
/* global setL10nAttributes, getL10nAttributes */
/* global getTranslatableChildren */
/* global walkContent, PSEUDO_STRATEGIES */

var DEBUG = false;
var isPretranslated = false;
var rtlList = ['ar', 'he', 'fa', 'ps', 'qps-plocm', 'ur'];
var nodeObserver = null;
var pendingElements = null;
var headScanCompleted = false;
var manifestLoading = false;
var manifest = {};

var moConfig = {
  attributes: true,
  characterData: false,
  childList: true,
  subtree: true,
  attributeFilter: ['data-l10n-id', 'data-l10n-args']
};

// Public API

navigator.mozL10n = {
  ctx: new Context(),
  get: function get(id, ctxdata) {
    return navigator.mozL10n.ctx.get(id, ctxdata);
  },
  localize: function localize(element, id, args) {
    return localizeElement.call(navigator.mozL10n, element, id, args);
  },
  translate: function () {
    // XXX: Remove after removing obsolete calls. Bugs 992473 and 1020136
  },
  translateFragment: function (fragment) {
    return translateFragment.call(navigator.mozL10n, fragment);
  },
  setAttributes: setL10nAttributes,
  getAttributes: getL10nAttributes,
  ready: function ready(callback) {
    return navigator.mozL10n.ctx.ready(callback);
  },
  once: function once(callback) {
    return navigator.mozL10n.ctx.once(callback);
  },
  get readyState() {
    return navigator.mozL10n.ctx.isReady ? 'complete' : 'loading';
  },
  language: {
    set code(lang) {
      navigator.mozL10n.ctx.requestLocales(lang);
    },
    get code() {
      return navigator.mozL10n.ctx.supportedLocales[0];
    },
    get direction() {
      return getDirection(navigator.mozL10n.ctx.supportedLocales[0]);
    }
  },
  qps: PSEUDO_STRATEGIES,
  _getInternalAPI: function() {
    return {
      Error: L10nError,
      Context: Context,
      Locale: Locale,
      Entity: Entity,
      getPluralRule: getPluralRule,
      rePlaceables: rePlaceables,
      getTranslatableChildren:  getTranslatableChildren,
      translateDocument: translateDocument,
      onLinkInjected: onLinkInjected,
      onMetaInjected: onMetaInjected,
      fireLocalizedEvent: fireLocalizedEvent,
      PropertiesParser: PropertiesParser,
      compile: compile,
      walkContent: walkContent
    };
  }
};

navigator.mozL10n.ctx.ready(onReady.bind(navigator.mozL10n));

if (DEBUG) {
  navigator.mozL10n.ctx.addEventListener('error', console.error);
  navigator.mozL10n.ctx.addEventListener('warning', console.warn);
}

function getDirection(lang) {
  return (rtlList.indexOf(lang) >= 0) ? 'rtl' : 'ltr';
}

var readyStates = {
  'loading': 0,
  'interactive': 1,
  'complete': 2
};

function waitFor(state, callback) {
  state = readyStates[state];
  if (readyStates[document.readyState] >= state) {
    callback();
    return;
  }

  document.addEventListener('readystatechange', function l10n_onrsc() {
    if (readyStates[document.readyState] >= state) {
      document.removeEventListener('readystatechange', l10n_onrsc);
      callback();
    }
  });
}

if (window.document) {
  isPretranslated = !PSEUDO_STRATEGIES.hasOwnProperty(navigator.language) &&
                    (document.documentElement.lang === navigator.language);

  // XXX always pretranslate if data-no-complete-bug is set;  this is
  // a workaround for a netError page not firing some onreadystatechange
  // events;  see https://bugzil.la/444165
  var pretranslate = document.documentElement.dataset.noCompleteBug ?
    true : !isPretranslated;
  waitFor('interactive', init.bind(navigator.mozL10n, pretranslate));
}

function initObserver() {
  nodeObserver = new MutationObserver(onMutations.bind(navigator.mozL10n));
  nodeObserver.observe(document, moConfig);
}

function init(pretranslate) {
  if (pretranslate) {
    inlineLocalization.call(navigator.mozL10n);
    initResources.call(navigator.mozL10n);
  } else {
    // if pretranslate is false, we want to initialize MO
    // early, to collect nodes injected between now and when resources
    // are loaded because we're not going to translate the whole
    // document once l10n resources are ready.
    initObserver();
    window.setTimeout(initResources.bind(navigator.mozL10n));
  }
}

function inlineLocalization() {
  var locale = this.ctx.getLocale(navigator.language);
  var scriptLoc = locale.isPseudo ? this.ctx.defaultLocale : locale.id;
  var script = document.documentElement
                       .querySelector('script[type="application/l10n"]' +
                       '[lang="' + scriptLoc + '"]');
  if (!script) {
    return;
  }

  // the inline localization is happenning very early, when the ctx is not
  // yet ready and when the resources haven't been downloaded yet;  add the
  // inlined JSON directly to the current locale
  locale.addAST(JSON.parse(script.innerHTML));
  // localize the visible DOM
  var l10n = {
    ctx: locale,
    language: {
      code: locale.id,
      direction: getDirection(locale.id)
    }
  };
  translateDocument.call(l10n);

  // the visible DOM is now pretranslated
  isPretranslated = true;
}

function initResources() {
  var nodes = document.head
                      .querySelectorAll('link[rel="localization"],' +
                                        'link[rel="manifest"],' +
                                        'meta[name="locales"],' +
                                        'meta[name="default_locale"]');
  for (var i = 0; i < nodes.length; i++) {
    var nodeName = nodes[i].nodeName.toLowerCase();
    switch (nodeName) {
      case 'link':
        onLinkInjected.call(this, nodes[i]);
        break;
      case 'meta':
        onMetaInjected.call(this, nodes[i]);
        break;
    }
  }

  headScanCompleted = true;

  if (Object.keys(manifest).length === 2 ||
      manifestLoading === false) {
    initLocale.call(this);
  }
}

function onLinkInjected(node) {
  var url = node.getAttribute('href');
  var rel = node.getAttribute('rel');
  switch (rel) {
    case 'manifest':
      loadManifest.call(this, url);
      break;
    case 'localization':
      this.ctx.resLinks.push(url);
      break;
  }
}

function onMetaInjected(node) {
  if (Object.keys(manifest).length === 2) {
    return;
  }
  var name = node.getAttribute('name');
  switch (name) {
    case 'locales':
      manifest[name] = node.getAttribute('content').split(',').map(
        Function.prototype.call, String.prototype.trim);
      break;
    case 'default_locale':
      manifest[name] = node.getAttribute('content');
      break;
  }

  if (Object.keys(manifest).length === 2) {
    parseManifest.call(this);
  }
}

function loadManifest(url) {
  if (Object.keys(manifest).length === 2) {
    return;
  }

  manifestLoading = true;

  io.loadJSON(url, function(err, json) {
    manifestLoading = false;

    if (Object.keys(manifest).length === 2) {
      return;
    }

    if (err) {
      this.ctx._emitter.emit('error', err);
      if (headScanCompleted) {
        initLocale.call(this);
      }
      return;
    }

    if (!('default_locale' in manifest)) {
      manifest.default_locale = json.default_locale;
    }
    if (!('locales' in manifest)) {
      manifest.locales = Object.keys(json.locales);
    }

    parseManifest.call(this);
  }.bind(this));
}

function parseManifest() {
  this.ctx.registerLocales(manifest.default_locale,
                           manifest.locales);
  manifest = {};
  if (headScanCompleted) {
    initLocale.call(this);
  }
}

function initLocale() {
  this.ctx.requestLocales.apply(this.ctx, navigator.languages);
  window.addEventListener('languagechange', function l10n_langchange() {
    this.ctx.requestLocales.apply(this.ctx, navigator.languages);
  }.bind(this));
}

function localizeMutations(mutations) {
  var mutation;

  for (var i = 0; i < mutations.length; i++) {
    mutation = mutations[i];
    if (mutation.type === 'childList') {
      var addedNode;

      for (var j = 0; j < mutation.addedNodes.length; j++) {
        addedNode = mutation.addedNodes[j];

        if (addedNode.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }

        if (addedNode.childElementCount) {
          translateFragment.call(this, addedNode);
        } else if (addedNode.hasAttribute('data-l10n-id')) {
          translateElement.call(this, addedNode);
        }
      }
    }

    if (mutation.type === 'attributes') {
      translateElement.call(this, mutation.target);
    }
  }
}

function onMutations(mutations, self) {
  self.disconnect();
  localizeMutations.call(this, mutations);
  self.observe(document, moConfig);
}

function onReady() {
  if (!isPretranslated) {
    translateDocument.call(this);
  }
  isPretranslated = false;

  if (pendingElements) {
    /* jshint boss:true */
    for (var i = 0, element; element = pendingElements[i]; i++) {
      translateElement.call(this, element);
    }
    pendingElements = null;
  }

  if (!nodeObserver) {
    initObserver();
  }
  fireLocalizedEvent.call(this);
}

function fireLocalizedEvent() {
  var event = new CustomEvent('localized', {
    'bubbles': false,
    'cancelable': false,
    'detail': {
      'language': this.ctx.supportedLocales[0]
    }
  });
  window.dispatchEvent(event);
}
