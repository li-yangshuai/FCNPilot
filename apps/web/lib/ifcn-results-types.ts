export interface IfcnRunSummary {
  id: string;
  module: string;
  sourceName: string;
  designType: "combinational" | "sequential" | null;
  status: string;
  currentStage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  algorithm: string | null;
  optimizationPolicy?: "llm" | "noop" | "random" | "heuristic" | null;
  clockScheme: string | null;
  artifactCount: number;
}

export interface IfcnRunArtifact {
  name: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  preview: "svg" | "qca" | "ifcn" | null;
  downloadUrl: string;
  previewUrl: string | null;
}

export interface IfcnRunDetail extends IfcnRunSummary {
  stages: {
    id: string;
    status: string;
    attempt: number;
    startedAt?: string;
    completedAt?: string;
  }[];
  requestedUntil: string | null;
  metrics: Record<string, unknown>;
  validation: Record<string, unknown>;
  error: string | null;
  artifacts: IfcnRunArtifact[];
}
