import {SimpleSpanProcessor} from '@opentelemetry/tracing';
import {WebTracerProvider} from '@opentelemetry/web';
import {DocumentLoad} from '@opentelemetry/plugin-document-load';
import {XMLHttpRequestPlugin} from '@opentelemetry/plugin-xml-http-request';
import {UserInteractionPlugin} from '@opentelemetry/plugin-user-interaction';
import {FetchPlugin} from "@opentelemetry/plugin-fetch";
import {PatchedZipkinExporter} from './zipkin';
import {captureTraceParent, captureTraceParentFromPerformanceEntries} from './servertiming';
import {captureErrors} from "./errors";
import {generateId} from "./utils";
import {version as SplunkRumVersion} from "../package.json";

if (!window.SplunkRum) {
  window.SplunkRum = {
    inited: false
  };

  window.SplunkRum.init = function (options) {
    if (this.inited) {
      console.log("SplunkRum already init()ed.");
      return;
    }
    if (!options.beaconUrl) {
      // FIXME error handling
      console.log("SplunkRum.init( {beaconUrl: 'https://something'} ) is required.");
      return;
    }
    const app = options.app || 'unknown-browser-app';

    const instanceId = generateId(64);

    const exportUrl = options.beaconUrl;

    const cookieName = "_splunk_rum_sid";

    if (!document.cookie.includes(cookieName)) {
      var sessionId = generateId(128);
      document.cookie = cookieName + '=' + sessionId + "; path=/";
    }
    var rumSessionId = function () {
      var decodedCookie = decodeURIComponent(document.cookie);
      var cookies = decodedCookie.split(';');
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.indexOf(cookieName + '=') === 0) {
          return c.substring((cookieName + '=').length, c.length);
        }
      }
      return undefined;
    }();

    const whitelistEventTypes = {
      click: true,
      dblclick: true,
      submit: true,
      reset: true,
      dragend: true,
      drop: true,
      ended: true,
      pause: true,
      play: true,
      change: true,
      mousedown: true,
      mouseup: true,
    };

    class PatchedUIP extends UserInteractionPlugin {
      getZoneWithPrototype() {
        // FIXME work out ngZone issues with Angular  PENDING
        return undefined;
      }

      _allowEventType(eventType) {
        return whitelistEventTypes[eventType];
      }

      // FIXME find cleaner way to patch
      _patchHistoryMethod() {
        return (original) => {
          return function patchHistoryMethod(...args) {
            const oldHref = location.href;
            const result = original.apply(this, args);
            const newHref = location.href;
            if (oldHref !== newHref) {
              // FIXME names of attributes/span/component
              const tracer = window.SplunkRum._provider.getTracer('route');
              const span = tracer.startSpan('route change');
              span.setAttribute('prev.href', oldHref)
              // location.href set with new value by default
              span.end(span.startTime);
            }
            return result;
          };
        };
      }
    }
    const uip = new PatchedUIP();

    // suppress behavior of renaming spans as 'Navigation {new href}'
    uip._updateInteractionName = function() {}


    // FIXME this is still not the cleanest way to add an attribute to all created spans..,
    class PatchedWTP extends WebTracerProvider {
      constructor(config) {
        super(config);
      }

      getTracer(name, version, config) {
        const tracer = super.getTracer(name, version, config);
        const origStartSpan = tracer.startSpan;
        tracer.startSpan = function () {
          const span = origStartSpan.apply(tracer, arguments);
          span.setAttribute('location.href', location.href);
          // FIXME does otel want this stuff in Resource?
          span.setAttribute('splunk.rumSessionId', rumSessionId);
          span.setAttribute('splunk.rumVersion', SplunkRumVersion);
          span.setAttribute('app', app);
          span.setAttribute('splunk.scriptInstance', instanceId)
          return span;
        }
        return tracer;
      }
    }

    const xhrplugin = new XMLHttpRequestPlugin();

    // FIXME another thing to figure out how to patch more cleanly
    const origCreateSpan = xhrplugin._createSpan;
    xhrplugin._createSpan = function () {
      const xhr = arguments[0];
      const span = origCreateSpan.apply(xhrplugin, arguments);
      // don't care about success/failure, just want to see response headers if they exist
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState == xhr.HEADERS_RECEIVED && xhr.getAllResponseHeaders().includes('server-timing')) {
          const st = xhr.getResponseHeader('server-timing');
          if (st) {
            captureTraceParent(st, span);
          }
        }
      });
      // FIXME long-term answer for depcreating attributes.component?
      span.setAttribute('component', xhrplugin.moduleName);
      return span;
    }

    // And now for patching in docload to look for Server-Timing
    const docLoad = new DocumentLoad();
    const origEndSpan = docLoad._endSpan;
    docLoad._endSpan = function (span, performanceName, entries) {
      if (span && span.name !== 'documentLoad') { // only apply link to document fetch
        captureTraceParentFromPerformanceEntries(entries, span);
      }
      return origEndSpan.apply(docLoad, arguments);
    };
    // To maintain compatibility, getEntries copies out select items from
    // different versions of the performance API into its own structure for the
    // intitial document load (but leaves the entries undisturbed for resource loads).
    const origGetEntries = docLoad._getEntries;
    docLoad._getEntries = function () {
      const answer = origGetEntries.apply(docLoad, arguments);
      const navEntries = performance.getEntriesByType('navigation');
      if (navEntries && navEntries[0] && navEntries[0].serverTiming) {
        answer.serverTiming = navEntries[0].serverTiming;
      }
      return answer;
    };

    // A random place to list a bunch of items that are unresolved
    // FIXME is there any way to tell that a resource load failed from its performance entry?
    // FIXME pull in latest plugins with my added request size for xhr/fetch/load  PENDING
    // FIXME longtask
    // FIXME repo/licensing issues
    // FIXME strip http.user_agent from spans as redundant
    // FIXME rumKey

    const fetch = new FetchPlugin();
    const origAFSA = fetch._addFinalSpanAttributes;
    fetch._addFinalSpanAttributes = function () {
      if (arguments.length >= 2) {
        const span = arguments[0];
        const fetchResponse = arguments[1];
        if (span && fetchResponse && fetchResponse.headers) {
          const st = fetchResponse.headers.get('Server-Timing');
          if (st) {
            captureTraceParent(st, span);
          }
        }
      }
      origAFSA.apply(fetch, arguments);
    };

    const provider = new PatchedWTP({
      plugins: [
        docLoad,
        xhrplugin,
        fetch,
        uip,
      ],
    });

    provider.addSpanProcessor(new SimpleSpanProcessor(new PatchedZipkinExporter(exportUrl)));
    provider.register();
    Object.defineProperty(this, '_provider', {value:provider});
    if (options.captureErrors === undefined || options.captureErrors === true) {
      captureErrors(this, provider); // also registers SplunkRum.error
    } else {
      // stub out error reporting method to not break apps that call it
      this.error = function() { }
    }
    this.inited = true;
    console.log('SplunkRum.init() complete');
  };
}