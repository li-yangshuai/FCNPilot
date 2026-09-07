"use client";

interface FcnPilotIconProps {
  size?: number;
  animated?: boolean;
  motion?: "none" | "float" | "thinking";
}

export function FcnPilotIcon({ size = 28, animated = false, motion }: FcnPilotIconProps) {
  const resolvedMotion = motion ?? (animated ? "float" : "none");

  return (
    <span
      aria-hidden="true"
      className={`amedac-mark amedac-mark--${resolvedMotion}`}
      style={{
        width: size,
        height: size,
      }}
    >
      {resolvedMotion === "thinking" && (
        <>
          <span className="amedac-mark__energy" />
          <span className="amedac-mark__orbit amedac-mark__orbit--outer" />
          <span className="amedac-mark__orbit amedac-mark__orbit--inner" />
          <span className="amedac-mark__scanner" />
          <span className="amedac-mark__particles" />
        </>
      )}
      <span
        className="amedac-mark__core"
        style={{
          background: 'url("/icon.svg?v=ifcn-circuit-v2") center / contain no-repeat',
        }}
      />
    </span>
  );
}
