/**
 * Hook for Telegram WebApp SDK.
 * Uses the globally injected window.Telegram.WebApp object (from telegram-web-app.js).
 */

interface TelegramMainButton {
  text: string;
  setText: (text: string) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  onClick: (fn: () => void) => void;
  offClick: (fn: () => void) => void;
}

interface TelegramBackButton {
  isVisible: boolean;
  show: () => void;
  hide: () => void;
  onClick: (fn: () => void) => void;
  offClick: (fn: () => void) => void;
}

interface TelegramHapticFeedback {
  impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  notificationOccurred: (type: "error" | "success" | "warning") => void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; username?: string; first_name?: string } };
  colorScheme: "light" | "dark";
  expand: () => void;
  ready: () => void;
  close: () => void;
  HapticFeedback: TelegramHapticFeedback;
  MainButton: TelegramMainButton;
  BackButton: TelegramBackButton;
}

function getWebApp(): TelegramWebApp | null {
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } })
    ?.Telegram?.WebApp ?? null;
}

export function useTelegram() {
  const webApp = getWebApp();

  return {
    webApp,
    initData: webApp?.initData ?? "",
    user: webApp?.initDataUnsafe?.user ?? null,
    colorScheme: webApp?.colorScheme ?? "light",

    close: () => webApp?.close(),

    haptic: {
      impact: (style: "light" | "medium" | "heavy" | "rigid" | "soft" = "medium") =>
        webApp?.HapticFeedback?.impactOccurred(style),
      notification: (type: "error" | "success" | "warning") =>
        webApp?.HapticFeedback?.notificationOccurred(type),
    },

    mainButton: webApp?.MainButton,
    backButton: webApp?.BackButton,
  };
}
