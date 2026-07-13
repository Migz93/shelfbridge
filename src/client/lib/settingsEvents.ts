export const SETTINGS_CHANGED_EVENT = "shelfbridge:settings-changed";

export function notifySettingsChanged(): void {
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}
