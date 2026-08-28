const LEGACY_MANAGED_HOSTS = new Set([
  "poracode.com",
  "app.poracode.com",
  "app-nightly.poracode.com",
]);

const ANDROID_INTENT_FILTER_RE = /\s*<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g;
const IOS_ASSOCIATED_DOMAINS_RE =
  /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>([\s\S]*?)<\/array>/;
const IOS_STRING_RE = /<string>([^<]+)<\/string>/g;

function isManagedAndroidFilter(filter) {
  if (!/android:autoVerify="true"/.test(filter)) return false;
  const hosts = [...filter.matchAll(/android:host="([^"]+)"/g)].map((entry) => entry[1]);
  if (hosts.some((host) => LEGACY_MANAGED_HOSTS.has(host))) return true;

  return (
    /android:name="android\.intent\.action\.VIEW"/.test(filter) &&
    /android:name="android\.intent\.category\.BROWSABLE"/.test(filter) &&
    /android:pathPrefix="\/pair"/.test(filter) &&
    /android:pathPrefix="\/app"/.test(filter)
  );
}

function androidIntentFilter(host) {
  return `
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />

                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />

                <data android:scheme="https" android:host="${host}" android:pathPrefix="/pair" />
                <data android:scheme="https" android:host="${host}" android:pathPrefix="/app" />
            </intent-filter>`;
}

export function replaceManagedAndroidAppLinks(manifest, host) {
  const withoutManaged = manifest.replace(ANDROID_INTENT_FILTER_RE, (filter) =>
    isManagedAndroidFilter(filter) ? "" : filter,
  );
  if (!host) return withoutManaged;
  const next = withoutManaged.replace(
    /(<activity\b[^>]*android:name="\.MainActivity"[\s\S]*?)(\s*<\/activity>)/,
    `$1${androidIntentFilter(host)}$2`,
  );
  if (next === withoutManaged) {
    throw new Error("unable to locate Android MainActivity");
  }
  return next;
}

function parseAssociatedDomain(value) {
  const match = /^(applinks|webcredentials):(.+)$/.exec(value);
  return match ? { service: match[1], host: match[2] } : null;
}

function managedIosHosts(values) {
  const servicesByHost = new Map();
  for (const value of values) {
    const parsed = parseAssociatedDomain(value);
    if (!parsed) continue;
    const services = servicesByHost.get(parsed.host) ?? new Set();
    services.add(parsed.service);
    servicesByHost.set(parsed.host, services);
  }
  const managed = new Set(LEGACY_MANAGED_HOSTS);
  for (const [host, services] of servicesByHost) {
    // Previous versions of the configurator always wrote this pair. Treating
    // paired entries as managed lets a host change replace the prior value
    // while preserving unrelated single-service associated domains.
    if (services.has("applinks") && services.has("webcredentials")) managed.add(host);
  }
  return managed;
}

function associatedDomainsXml(values) {
  return `<key>com.apple.developer.associated-domains</key>
\t<array>
${values.map((value) => `\t\t<string>${value}</string>`).join("\n")}
\t</array>`;
}

export function replaceManagedIosAssociatedDomains(entitlements, host) {
  const match = IOS_ASSOCIATED_DOMAINS_RE.exec(entitlements);
  const domainValues = host ? [`applinks:${host}`, `webcredentials:${host}`] : [];
  if (!match) {
    if (!host) return entitlements;
    return entitlements.replace(
      /\n<\/dict>\s*<\/plist>\s*$/,
      `\n\t${associatedDomainsXml(domainValues)}\n</dict>\n</plist>\n`,
    );
  }

  const currentValues = [...match[1].matchAll(IOS_STRING_RE)].map((entry) => entry[1]);
  const managedHosts = managedIosHosts(currentValues);
  const preserved = currentValues.filter((value) => {
    const parsed = parseAssociatedDomain(value);
    return !parsed || !managedHosts.has(parsed.host);
  });
  const nextValues = [...new Set([...preserved, ...domainValues])];
  if (nextValues.length === 0) {
    return entitlements.replace(IOS_ASSOCIATED_DOMAINS_RE, "");
  }
  return entitlements.replace(IOS_ASSOCIATED_DOMAINS_RE, associatedDomainsXml(nextValues));
}
