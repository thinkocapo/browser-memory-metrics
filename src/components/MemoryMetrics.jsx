import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  recordHeapSample,
  setActiveFlow,
  clearActiveFlow,
} from '../utils/memoryMetrics';

// How long after a route commits to take the "settled" reading. Long enough for
// data fetches to resolve and render.
const SETTLE_DELAY_MS = 1200;

/**
 * TECHNIQUE 2 (labelled boundaries): a render-nothing component that records a
 * heap reading at each step of a transition, so a journey produces a LABELLED
 * series rather than one undifferentiated line.
 *
 * There is nothing to render -- this returns null. It exists only so React's
 * lifecycle gives you clean "enter" and "leave" hooks to sample on.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO USE IT
 * ---------------------------------------------------------------------------
 *
 * (a) Route-scoped (drop-in). Mount ONE instance inside your router and it
 *     samples on every route change. Good when your app is page-based:
 *
 *       <BrowserRouter>
 *         <MemoryMetrics />          // samples every route transition
 *         ... your routes ...
 *       </BrowserRouter>
 *
 * (b) Flow-scoped. You are usually NOT measuring "a route" -- you are measuring
 *     a flow that may span many routes or none (a long-lived dashboard is a single
 *     route). Pass a `flow` name and mount the component around the subtree that
 *     represents that flow. Every reading taken while it is mounted -- including
 *     the always-on interval readings from startHeapSampling() -- is tagged with
 *     the flow:
 *
 *       {isDashboardOpen && <MemoryMetrics flow="Dashboard session" />}
 *
 *     On mount it calls setActiveFlow(flow); on unmount it clears it. That is
 *     what lets the interval sampler label its readings without you threading
 *     the flow name through every call.
 *
 * If you would rather not mount a component at all, call recordHeapSample() or
 * recordFlowCheckpoint() directly at the checkpoints in your flow code. This
 * component is just a convenient place to hang those calls.
 */
export default function MemoryMetrics({ flow }) {
  const { pathname } = useLocation();

  // Flow-scoped: announce the flow for as long as this component is mounted.
  useEffect(() => {
    if (!flow) return undefined;
    setActiveFlow(flow);
    return () => clearActiveFlow();
  }, [flow]);

  // Boundary samples. When `flow` is set these inherit it via the active flow;
  // we also pass it explicitly so the reading is tagged even if this fires
  // before the effect above.
  useEffect(() => {
    recordHeapSample({ phase: 'route_enter', route: pathname, flow });

    const settleTimer = setTimeout(() => {
      recordHeapSample({ phase: 'route_settled', route: pathname, flow });
    }, SETTLE_DELAY_MS);

    return () => {
      clearTimeout(settleTimer);
      recordHeapSample({ phase: 'route_leave', route: pathname, flow });
    };
  }, [pathname, flow]);

  return null;
}
