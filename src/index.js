// =============================================================================
// index.js -- REFERENCE EXCERPT (not a full app entry point)
//
// This shows only the places heap instrumentation + tracing touch your app
// entry file. Everything else from a real index.js (store, providers, the rest
// of Sentry.init) is elided with "...". Copy the marked pieces into your own
// entry file; do not run this file as-is.
// =============================================================================

import React, { useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  useNavigationType,
  createRoutesFromChildren,
  matchRoutes,
} from 'react-router-dom';
import * as Sentry from '@sentry/react';

// (1) Import the instrumentation.
import MemoryMetrics from './components/MemoryMetrics';
import { startHeapSampling } from './utils/memoryMetrics';

// -----------------------------------------------------------------------------
// (2) Sentry.init: TRACING and METRICS both need to be on.
//
//   - enableMetrics: true      -> or Sentry.metrics.* is silently dropped.
//   - tracesSampleRate > 0 +   -> or you get metrics with nothing to correlate
//     the react-router tracing     them to. Tracing is what tells you WHAT the
//     integration                  app was doing when the heap moved; the metric
//                                  is the number, the trace is the story.
// -----------------------------------------------------------------------------
Sentry.init({
  dsn: '<your-dsn>',

  // --- TRACING (required) --------------------------------------------------
  // Turn tracing on. Metrics are recorded regardless of this rate (they're not
  // sampled), but WITHOUT tracing you can't correlate a heap reading to the
  // request/interaction that produced it. Start at 1.0 while validating, then
  // dial down (e.g. 0.1) for production volume -- the heap curve stays unbroken
  // either way.
  tracesSampleRate: 1.0,

  // Which outgoing requests get trace headers, so backend spans join the same
  // trace as the frontend.
  tracePropagationTargets: ['localhost', /^https:\/\/yourapp\.com\/api/],

  integrations: [
    // React Router v6 tracing: creates a pageload/navigation transaction per
    // route and gives every route change a span the heap reading can attach to.
    // (react-router v7? use reactRouterV7BrowserTracingIntegration instead.)
    Sentry.reactRouterV6BrowserTracingIntegration({
      useEffect,
      useLocation,
      useNavigationType,
      createRoutesFromChildren,
      matchRoutes,
    }),
  ],
  // -------------------------------------------------------------------------

  enableMetrics: true, // <-- required for Sentry.metrics.gauge() to do anything
});

// Wrap your <Routes> so route transitions become navigation transactions.
const SentryRoutes = Sentry.withSentryReactRouterV6Routing(Routes);

// -----------------------------------------------------------------------------
// (3a) ALWAYS-ON baseline. Call once, right after Sentry.init(), BEFORE React
//      renders, so the app_load reading reflects the heap before any UI mounts.
//      This is the "runs at all times on an interval" half.
// -----------------------------------------------------------------------------
startHeapSampling();

// -----------------------------------------------------------------------------
// (3b) LABELLED boundaries. Mount the render-nothing <MemoryMetrics /> inside
//      your router. This is a SEPARATE, ADDITIONAL place readings are taken --
//      it does not replace startHeapSampling(); the two work together.
//
//      Route-scoped form (samples on every route change):
// -----------------------------------------------------------------------------
function AppRoutes() {
  return (
    <BrowserRouter>
      <MemoryMetrics />
      <SentryRoutes>{/* ... your routes ... */}</SentryRoutes>
    </BrowserRouter>
  );
}

// Flow-scoped form (tags every reading -- including the interval ones -- with a
// named flow for as long as the subtree is mounted):
//
//   {isDashboardOpen && <MemoryMetrics flow="Dashboard session" />}
//
// See README.md for when to prefer each, and for tagging the flow.

export default AppRoutes;
