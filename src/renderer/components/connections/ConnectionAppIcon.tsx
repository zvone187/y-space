import { useState } from "react";
import { Blocks } from "lucide-react";
import type { PipedreamAppSummary } from "@/shared/contracts";

export function ConnectionAppIcon(props: { app: PipedreamAppSummary }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--hairline)] bg-white/75 text-muted">
      {props.app.iconUrl && !failed ? (
        <img
          src={props.app.iconUrl}
          alt=""
          className="size-6 object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Blocks className="size-4" aria-hidden />
      )}
    </span>
  );
}
