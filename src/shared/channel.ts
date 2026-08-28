export type PoracodeChannel = "stable" | "nightly";

export const PORACODE_CHANNELS: readonly PoracodeChannel[] = ["stable", "nightly"];

declare const __PORACODE_CHANNEL__: string | undefined;

export function normalizeChannel(value: unknown): PoracodeChannel {
  return value === "nightly" ? "nightly" : "stable";
}

export function resolvePoracodeChannel(): PoracodeChannel {
  return normalizeChannel(typeof __PORACODE_CHANNEL__ === "string" ? __PORACODE_CHANNEL__ : "");
}

export function productNameFor(channel: PoracodeChannel): string {
  return channel === "nightly" ? "Y Space Nightly" : "Y Space";
}

export function appIdFor(channel: PoracodeChannel): string {
  // Keep the original install identity so Y Space upgrades existing Lightcode
  // and Poracode installs while retaining OS-owned credentials and permissions.
  return channel === "nightly" ? "com.lightcode.app.nightly" : "com.lightcode.app";
}

export function userDataDirNameFor(channel: PoracodeChannel): string {
  return channel === "nightly" ? ".poracode-nightly" : ".poracode";
}

export function updaterChannelFor(channel: PoracodeChannel): string | undefined {
  return channel === "nightly" ? "nightly" : undefined;
}

export function artifactPrefixFor(channel: PoracodeChannel): string {
  return channel === "nightly" ? "Y-Space-Nightly" : "Y-Space";
}
