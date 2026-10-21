import type { KeyboardEvent } from "react";

/**
 * Implements the horizontal ARIA tabs keyboard pattern while preserving the
 * visual direction of ArrowLeft/ArrowRight in RTL layouts.
 */
export function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

  const tabList = event.currentTarget.closest<HTMLElement>('[role="tablist"]');
  if (!tabList) return;
  const tabs = Array.from(
    tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
  );
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length < 2) return;

  event.preventDefault();
  let nextIndex: number;
  if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  } else {
    const rtl = getComputedStyle(tabList).direction === "rtl";
    const visuallyForward = event.key === "ArrowRight" ? 1 : -1;
    const delta = rtl ? -visuallyForward : visuallyForward;
    nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
  }

  const nextTab = tabs[nextIndex];
  nextTab.focus();
  nextTab.click();
}
