export interface AnalysisPipelineEvent {
  imageId: string;
  imageBase64: string;
  imageMediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  gridSize?: number; // rows × cols, default 3 → 9 regions
}

export interface ImageRegion {
  index: number;
  row: number;
  col: number;
  gridSize: number;
  label: string; // e.g. "top-left (rows 0-33%, cols 0-33%)"
}

export interface RegionFinding {
  regionIndex: number;
  regionLabel: string;
  objects: string[];
  features: string[];
  analysis: string;
}

export interface AnalysisSynthesis {
  overallDescription: string;
  dominantObjects: string[];
  sceneType: string;
  cvInsights: string[];
}

export interface AnalysisResult {
  imageId: string;
  regionCount: number;
  successfulRegions: number;
  findings: RegionFinding[];
  synthesis: AnalysisSynthesis;
  storedAt: string;
}
