"use client";

import { useEffect, useState } from "react";

/** PC(마우스·트랙패드) vs 터치 태블릿(iPad·갤럭시 탭 등) */
export type InkInputProfile = "desktop" | "tablet";

function isTabletUserAgent(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad/i.test(ua)) return true;
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  if (/Android/i.test(ua)) {
    if (!/Mobile/i.test(ua)) return true;
    if (typeof screen !== "undefined") {
      const minSide = Math.min(screen.width, screen.height);
      if (minSide >= 600) return true;
    }
  }
  return false;
}

/**
 * 태블릿: 펜슬만 필기, 손가락은 이동·확대.
 * PC: 마우스·펜 필기, 손가락 필기는 UI에서 선택(기본 끔).
 */
export function detectInkInputProfile(): InkInputProfile {
  if (typeof window === "undefined") return "desktop";
  if (isTabletUserAgent()) return "tablet";

  const fine = window.matchMedia("(pointer: fine)").matches;
  const hover = window.matchMedia("(hover: hover)").matches;
  if (fine && hover) return "desktop";

  const touch = navigator.maxTouchPoints > 0;
  if (touch) return "tablet";

  return "desktop";
}

export function useInkInputProfile(): InkInputProfile {
  const [profile, setProfile] = useState<InkInputProfile>("desktop");
  useEffect(() => {
    setProfile(detectInkInputProfile());
  }, []);
  return profile;
}

export function isTabletPenOnlyProfile(profile: InkInputProfile): boolean {
  return profile === "tablet";
}

export function effectiveAllowFingerInk(
  profile: InkInputProfile,
  userWantsFingerInk: boolean,
): boolean {
  return profile === "desktop" && userWantsFingerInk;
}
