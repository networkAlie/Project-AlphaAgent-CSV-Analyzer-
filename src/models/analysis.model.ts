export interface Project {
  projectName: string;
  websiteUrl: string;
  sourcePlatform: string;
  categoryTags: string;
  launchStatus: string;
  rawDescription: string;
  potentialScore: number;
  analystNote: string;
  priorityScore?: number;
  // Verification fields
  verificationStatus: 'unverified' | 'verifying' | 'verified' | 'failed';
  verificationSummary?: string;
  verificationScore?: number;
  evidenceLinks?: { title: string; uri: string }[];
}

export interface SummaryStatistics {
  totalProjects: number;
  averagePotentialScore: number;
  highPotentialProjects: number;
  mediumPotentialProjects: number;
  upcomingProjects: number;
}

export interface ChartData {
  label: string;
  value: number;
}

export interface AnalysisResult {
  summaryStatistics: SummaryStatistics;
  categoryAnalysis: ChartData[];
  launchStatusAnalysis: ChartData[];
  potentialScoreDistribution: ChartData[];
  prioritizedProjects: Project[];
}