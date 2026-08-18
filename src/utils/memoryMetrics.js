import * as Sentry from '@sentry/react';

/**
 * Browser JS heap instrumentation -- REFERENCE IMPLEMENTATION.
 *
 * Sentry has no built-in memory/heap collection for the browser: browser
 * profiling is CPU-only, and there is no heap profiler in any JS SDK. So we
 * read the heap ourselves and ship it as an Application Metric.
 *
 * The one line that matters is Sentry.metrics.gauge(...). Everything else in
 * this file is about WHERE and WHEN you call it, and HOW you label it.
 *
 * We ship each reading two ways:
 *
 *   1. As a metric gauge (`Sentry.metrics.gauge`). Metrics are NOT subject to
 *      trace sampling, so the curve stays unbroken even at a low
 *      tracesSampleRate. This is the artifact you chart over time.
 *   2. As attributes on whatever span is active. That makes a heap reading
 *      correlatable to the exact trace it happened in.
 *
 * Every metric the SDK emits already carries trace_id and span_id, so the two
 * views join up on their own.
 *
 * PREREQUISITE: `enableMetrics: true` must be set in Sentry.init(). Without it,
 * Sentry.metrics.* accepts your calls and silently drops them. See index.js.
 *
 * CAVEAT: performance.memory is Chromium-only (Chrome/Edge). Firefox and Safari
 * return nothing and this module no-ops after logging once. The cross-browser
 * alternative, performance.measureUserAgentSpecificMemory(), requires COOP+COEP
 * cross-origin isolation.
 */

const HEAP_USED_METRIC = 'browser.memory.heap_used';
const HEAP_UTILIZATION_METRIC = 'browser.memory.heap_utilization';

// Sentry's recommendation for an always-on baseline is one reading roughly
// every 10 seconds. Frequent enough to catch a climb, cheap enough to run for
// the whole session. Tune to taste.
const DEFAULT_SAMPLE_INTERVAL_MS = 10000;
const MIN_SAMPLE_INTERVAL_MS = 250;

const sessionStartedAt = Date.now();

let intervalId = null;
let pagehideHandler = null;
let unsupportedAlreadyLogged = false;

// The "flow" the user is currently in (e.g. 'Onboarding flow'). Set this at
// the start of a flow so the always-on interval sampler tags every reading with
// it; clear it when the flow ends. See setActiveFlow() below.
let activeFlow = null;

/**
 * Read the current JS heap. Returns null where the API is unavailable.
 */
function readHeap() {
  const memory =
    typeof performance !== 'undefined' ? performance.memory : undefined;

  if (!memory || typeof memory.usedJSHeapSize !== 'number') {
    return null;
  }

  return {
    usedBytes: memory.usedJSHeapSize,
    totalBytes: memory.totalJSHeapSize,
    limitBytes: memory.jsHeapSizeLimit,
  };
}

/**
 * How long this browsing session has been alive. This is the axis that matters
 * for the "app gets slow over a long session" story -- heap plotted against
 * time-in-session rather than wall clock.
 */
function sessionElapsedMs() {
  return Date.now() - sessionStartedAt;
}

function currentRoute() {
  return typeof window !== 'undefined' && window.location
    ? window.location.pathname
    : 'unknown';
}

/**
 * Name the flow the user is in. Everything sampled while a flow is active --
 * including the always-on interval readings -- gets tagged with it, so you can
 * GroupBy `flow` in Sentry and get one series per journey.
 *
 *   setActiveFlow('Onboarding flow');   // at the entry point of the flow
 *   ...
 *   setActiveFlow(null);                    // when the flow completes / aborts
 */
export function setActiveFlow(flow) {
  activeFlow = flow || null;
}

export function clearActiveFlow() {
  activeFlow = null;
}

/**
 * Capture one heap reading.
 *
 * @param {object}  options
 * @param {string}  options.phase - Why this sample was taken. Free-form; the
 *   examples here use: app_load, interval, route_enter, route_settled,
 *   route_leave, pagehide, checkpoint.
 * @param {string} [options.route] - Route the sample belongs to. Defaults to
 *   the current pathname.
 * @param {string} [options.flow] - The high-level flow this reading is part of
 *   (e.g. 'Dashboard session'). Falls back to the active flow set via
 *   setActiveFlow(). This is the attribute you GroupBy in Sentry.
 * @param {string} [options.checkpoint] - Optional sub-step within the flow
 *   (e.g. 'step_1_completed', 'data_loaded'). Use it when you want to see
 *   heap at specific points inside one flow.
 */
export function recordHeapSample({ phase, route, flow, checkpoint } = {}) {
  const heap = readHeap();

  if (!heap) {
    if (!unsupportedAlreadyLogged) {
      unsupportedAlreadyLogged = true;
      console.warn(
        '[memoryMetrics] performance.memory unavailable (non-Chromium browser); heap metrics disabled'
      );
    }
    return null;
  }

  const resolvedRoute = route || currentRoute();
  const resolvedFlow = flow || activeFlow || undefined;
  const elapsedMs = sessionElapsedMs();

  const attributes = {
    phase: phase || 'unknown',
    route: resolvedRoute,
    session_elapsed_ms: elapsedMs,
    session_elapsed_min: Number((elapsedMs / 60000).toFixed(2)),
    heap_total_bytes: heap.totalBytes,
    heap_limit_bytes: heap.limitBytes,
  };

  // The flow tag -- this is what you GroupBy in the Sentry UI to get a widget
  // per flow. Only attach it when there is one, so untagged baseline readings
  // stay clean.
  if (resolvedFlow) {
    attributes.flow = resolvedFlow;
  }
  if (checkpoint) {
    attributes.checkpoint = checkpoint;
  }

  // ---- THE LINE THAT RECORDS THE METRIC ----------------------------------
  // A gauge is "the value right now." Sampling-independent; this is the time
  // series you chart.
  Sentry.metrics.gauge(HEAP_USED_METRIC, heap.usedBytes, {
    unit: 'byte',
    attributes,
  });
  // ------------------------------------------------------------------------

  // Percent of the browser's heap ceiling in use. Easier to alert on than raw
  // bytes, because the ceiling differs by device.
  if (heap.limitBytes > 0) {
    Sentry.metrics.gauge(
      HEAP_UTILIZATION_METRIC,
      Number(((heap.usedBytes / heap.limitBytes) * 100).toFixed(2)),
      { unit: 'percent', attributes }
    );
  }

  // Correlate the reading to the active trace, when there is one.
  const activeSpan = Sentry.getActiveSpan();
  if (activeSpan) {
    activeSpan.setAttributes({
      'memory.heap_used_bytes': heap.usedBytes,
      'memory.heap_used_mb': Number((heap.usedBytes / 1024 / 1024).toFixed(2)),
      'memory.heap_limit_bytes': heap.limitBytes,
      'memory.sample_phase': attributes.phase,
      'memory.session_elapsed_ms': elapsedMs,
      ...(resolvedFlow ? { 'memory.flow': resolvedFlow } : {}),
    });
  }

  return heap;
}

/**
 * Convenience wrapper for the "call this at a checkpoint in my flow" pattern.
 * Drop it anywhere in your flow code -- not just on route changes.
 *
 *   recordFlowCheckpoint('Onboarding flow', 'step_1_completed');
 */
export function recordFlowCheckpoint(flow, checkpoint) {
  return recordHeapSample({ phase: 'checkpoint', flow, checkpoint });
}

/**
 * ALTERNATIVE labelling technique: bake the flow into the METRIC NAME instead
 * of using an attribute. This produces a separate series per flow
 * (browser.memory.heap_used.onboarding_flow, ...). Simpler single-flow
 * dashboards, but you lose the ability to GroupBy one metric across flows and
 * you multiply the number of metric names. Prefer the attribute approach above
 * unless you have a specific reason. Shown here so you can compare.
 */
export function recordHeapSampleNamedByFlow(flowSlug, { phase } = {}) {
  const heap = readHeap();
  if (!heap) return null;

  Sentry.metrics.gauge(`${HEAP_USED_METRIC}.${flowSlug}`, heap.usedBytes, {
    unit: 'byte',
    attributes: { phase: phase || 'unknown', route: currentRoute() },
  });
  return heap;
}

/**
 * Sample interval, overridable via ?heapInterval=1000 so a live demo does not
 * have to wait 10s between points.
 */
function resolveSampleInterval() {
  try {
    const requested = new URLSearchParams(window.location.search).get(
      'heapInterval'
    );
    if (!requested) return DEFAULT_SAMPLE_INTERVAL_MS;

    const parsed = Number.parseInt(requested, 10);
    if (Number.isNaN(parsed)) return DEFAULT_SAMPLE_INTERVAL_MS;

    return Math.max(parsed, MIN_SAMPLE_INTERVAL_MS);
  } catch {
    return DEFAULT_SAMPLE_INTERVAL_MS;
  }
}

/**
 * TECHNIQUE 1 (always-on baseline): take a reading at app load, then sample on
 * a timer for the life of the session. Safe to call more than once; extra calls
 * are ignored.
 *
 * Call this ONCE, right after Sentry.init(). See index.js.
 */
export function startHeapSampling() {
  if (intervalId !== null) {
    return;
  }

  if (!readHeap()) {
    recordHeapSample({ phase: 'app_load' }); // logs the unsupported warning once
    return;
  }

  const intervalMs = resolveSampleInterval();

  // Baseline: SDK initialized, app booting.
  recordHeapSample({ phase: 'app_load' });

  intervalId = setInterval(() => {
    recordHeapSample({ phase: 'interval' });
  }, intervalMs);

  // A final reading as the tab goes away, so the curve has an endpoint.
  pagehideHandler = () => recordHeapSample({ phase: 'pagehide' });
  window.addEventListener('pagehide', pagehideHandler);

  console.log(
    `[memoryMetrics] heap sampling every ${intervalMs}ms -> ${HEAP_USED_METRIC}`
  );
}

/**
 * Stop sampling and detach listeners.
 */
export function stopHeapSampling() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }

  if (pagehideHandler) {
    window.removeEventListener('pagehide', pagehideHandler);
    pagehideHandler = null;
  }
}
