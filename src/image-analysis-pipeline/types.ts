export interface AnalysisPipelineEvent {
  imageId: string;
  executionId?: string;
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
  label: string;
}

export interface DetectedObject {
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: 'high' | 'medium' | 'low';
  primary: boolean;
}

export interface RegionFinding {
  regionIndex: number;
  regionLabel: string;
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
