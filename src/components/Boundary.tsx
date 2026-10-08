"use client";
// A small error boundary for the always-on pieces (Rat Cam, alerts, CA bar, tab bar). Before v0.1.36 one bad value in
// /api/live could throw inside one of them and take the whole page down with it; now only that piece goes quiet,
// and it tries again on the next live update.
import { Component, type ReactNode } from "react";

type P = { name: string; children: ReactNode; fallback?: ReactNode; resetKey?: unknown };
type S = { failed: boolean; key: unknown };

export default class Boundary extends Component<P, S> {
  state: S = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(p: P, s: S) {
    // a new live snapshot gives a failed piece another try
    return p.resetKey !== s.key ? { failed: false, key: p.resetKey } : null;
  }
  componentDidCatch(e: unknown) {
    console.warn(`[ratnet] ${this.props.name} failed and was hidden:`, e);
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
