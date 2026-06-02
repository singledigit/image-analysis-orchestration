export interface AnalysisPipelineEvent {
  imageId: string;
  executionId?: string;
  // Image supplied either as S3 reference (preferred) or inline base64
  imageS3Key?: string;
  imageBucket?: string;
  imageBase64?: string;
  imageMediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  gridSize?: number;
}

export interface ImageRegion {
  index: number;
  row: number;
  col: number;
  gridSize: number;
  label: string; // e.g. "top-left (rows 0-33%, cols 0-33%)"
}

export interface DetectedObject {
  label: string;
  // Normalized coords [0-1] relative to the full image (not the region)
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface RegionFinding {
  regionIndex: number;
  regionLabel: string;
  objects: string[];
  features: string[];
  analysis: string;
  detectedObjects?: DetectedObject[];
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
  thumbnailUrl?: string;
}
