import { Injectable } from '@angular/core';
import { Project, AnalysisResult, ChartData, SummaryStatistics } from '../models/analysis.model';
import { GoogleGenAI } from "@google/genai";

@Injectable({
  providedIn: 'root',
})
export class CsvAnalysisService {
  private ai: GoogleGenAI | null = null;

  public initializeAi(apiKey: string): void {
    if (!apiKey) {
      console.error("Attempted to initialize AI without an API key.");
      throw new Error("API key is required to initialize the AI service.");
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  public parseCsv(csvText: string): Project[] {
    // Handle BOM character at the start of the file
    if (csvText.charCodeAt(0) === 0xFEFF) {
      csvText = csvText.substring(1);
    }

    const lines = csvText.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const headerLine = lines.shift();
    if (!headerLine) return [];

    const parseLine = (row: string): string[] => {
      const values = [];
      let currentVal = '';
      let inQuotes = false;
      for (let i = 0; i < row.length; i++) {
        const char = row[i];
        if (char === '"') {
          if (inQuotes && row[i + 1] === '"') { // Escaped quote
            currentVal += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          values.push(currentVal.trim());
          currentVal = '';
        } else {
          currentVal += char;
        }
      }
      values.push(currentVal.trim());
      return values;
    };

    const fileHeaders = parseLine(headerLine).map(h => h.trim());

    const headerSynonyms: { [key in keyof Omit<Project, 'priorityScore' | 'verificationStatus' | 'verificationSummary' | 'verificationScore' | 'evidenceLinks'>]?: string[] } = {
        projectName: ['Proje_Adı', 'Proje Adı', 'Project Name'],
        websiteUrl: ['Website_URL', 'Website URL', 'Website'],
        sourcePlatform: ['Kaynak_Platform', 'Kaynak Platform', 'Source Platform', 'Source'],
        categoryTags: ['Kategori_Etiketler', 'Kategori Etiketleri', 'Category Tags', 'Categories', 'Tags'],
        launchStatus: ['Lansman_Tarihi_Durumu', 'Lansman Tarihi Durumu', 'Lansman Durumu', 'Launch Status'],
        rawDescription: ['Ham_Açıklama', 'Ham Açıklama', 'Açıklama', 'Description', 'Raw Description'],
        potentialScore: ['Potansiyel_Skoru', 'Potensiyel Skoru', 'Potential Score', 'Score', 'Puan'],
        analystNote: ['Analist_Notu', 'Analist Notu', 'Analyst Note', 'Note', 'Not']
    };
    
    // A more aggressive, direct sanitization function for header normalization.
    const normalizeHeader = (h: string): string => {
        if (!h) return '';
        return h
            .replace(/^\uFEFF/, '') // Remove BOM
            .trim()
            .toLowerCase()
            // Explicitly map Turkish characters to ASCII equivalents
            .replace(/ı/g, 'i')
            .replace(/ö/g, 'o')
            .replace(/ü/g, 'u')
            .replace(/ç/g, 'c')
            .replace(/ş/g, 's')
            .replace(/ğ/g, 'g')
            // Remove all non-alphanumeric characters to be safe
            .replace(/[^a-z0-9]/g, '');
    };

    const indexToPropertyMap = new Map<number, keyof Project>();
    const foundProperties = new Set<string>();

    fileHeaders.forEach((header, index) => {
        const normalizedHeader = normalizeHeader(header);
        if (!normalizedHeader) return; // Skip empty headers

        for (const prop in headerSynonyms) {
            const key = prop as keyof Project;
            const synonyms = headerSynonyms[key as keyof typeof headerSynonyms];
            if (synonyms?.map(normalizeHeader).includes(normalizedHeader)) {
                indexToPropertyMap.set(index, key);
                foundProperties.add(key);
                break;
            }
        }
    });

    const requiredProps: (keyof Project)[] = ['projectName', 'potentialScore'];
    const missingProps = requiredProps.filter(p => !foundProperties.has(p as string));
    if (missingProps.length > 0) {
        throw new Error(`Missing required columns. Could not find: ${missingProps.join(', ')} (or a valid alternative).`);
    }

    return lines.map(line => {
      if (!line.trim()) return null;

      const values = parseLine(line);
      const project: any = { verificationStatus: 'unverified' };
      
      values.forEach((value, index) => {
        const key = indexToPropertyMap.get(index);
        if (key) {
           if (key === 'potentialScore') {
            project[key] = parseFloat(value) || 0;
          } else {
            project[key] = value || '';
          }
        }
      });
      
      Object.keys(headerSynonyms).forEach(propKey => {
          if (project[propKey] === undefined) {
              project[propKey] = propKey === 'potentialScore' ? 0 : 'N/A';
          }
      });

      return project as Project;
    }).filter((p): p is Project => p !== null && !!p.projectName && p.projectName !== 'N/A');
  }
  
  public async verifyProject(project: Project): Promise<Partial<Project>> {
    if (!this.ai) {
      throw new Error('AI Service not initialized. An API key is required.');
    }

    const prompt = `
      Act as a meticulous Web3 project analyst. Your task is to verify the existence and legitimacy 
      of a project based on the data provided. Use the available search tool to find information online.
      Your response MUST be a JSON object. Do not include any other text or markdown formatting.

      Project Data:
      - Name: "${project.projectName}"
      - Website: "${project.websiteUrl}"
      - Categories: "${project.categoryTags}"
      - Description: "${project.rawDescription}"

      Based on your web search, provide a JSON object with the following keys:
      - "summary": A brief, one-sentence summary of the project's main purpose and current status.
      - "confidenceScore": An integer score from 0 to 100 representing your confidence that this is a real, active project. 0 means it's likely fake or defunct, 100 means it's highly legitimate and active.
    `;

    try {
      const response = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          tools: [{googleSearch: {}}],
        },
      });

      // Clean the response to remove markdown fences before parsing
      let jsonText = response.text;
      const match = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        jsonText = match[1];
      } else {
        jsonText = jsonText.trim();
      }

      const parsedJson = JSON.parse(jsonText);
      
      const evidenceLinks = response.candidates?.[0]?.groundingMetadata?.groundingChunks
        ?.map((chunk: any) => chunk.web)
        .filter((web: any, index: number, self: any[]) => 
          web && self.findIndex(w => w.uri === web.uri) === index
        ) || [];

      return {
        verificationStatus: 'verified',
        verificationSummary: parsedJson.summary,
        verificationScore: parsedJson.confidenceScore,
        evidenceLinks: evidenceLinks.slice(0, 3) // Return top 3 unique links
      };
    } catch (error) {
      console.error('Error verifying project with Gemini API:', error);
      return {
        verificationStatus: 'failed',
        verificationSummary: 'Could not verify project. The API call may have failed or returned an invalid format.'
      };
    }
  }


  public analyzeData(projects: Project[]): AnalysisResult {
    const cleanedProjects = this.cleanData(projects);
    const filteredProjects = this.applyAlphaHuntingFilters(cleanedProjects);
    const prioritizedProjects = this.prioritizeProjects(filteredProjects);
    
    const summaryStatistics = this.generateSummaryStats(prioritizedProjects);
    const categoryAnalysis = this.analyzeCategories(prioritizedProjects);
    const launchStatusAnalysis = this.analyzeLaunchStatus(prioritizedProjects);
    const potentialScoreDistribution = this.analyzePotentialScores(prioritizedProjects);

    return {
      summaryStatistics,
      categoryAnalysis,
      launchStatusAnalysis,
      potentialScoreDistribution,
      prioritizedProjects: prioritizedProjects.slice(0, 20), // Top 20 projects
    };
  }

  private cleanData(projects: Project[]): Project[] {
    return projects.map(p => ({
      ...p,
      websiteUrl: this.cleanUrl(p.websiteUrl),
      categoryTags: this.cleanCategories(p.categoryTags),
      potentialScore: !isNaN(p.potentialScore) ? p.potentialScore : 0
    }));
  }

  private cleanUrl(url: string): string {
    if (url === 'N/A' || !url) return 'N/A';
    if (!url.startsWith('http')) {
        return `https://${url}`;
    }
    return url;
  }

  private cleanCategories(categories: string): string {
     if (categories === 'N/A' || !categories) return 'N/A';
     return categories.split(',').map(cat => cat.trim()).join(', ');
  }

  private applyAlphaHuntingFilters(projects: Project[]): Project[] {
      let filtered = projects;

      // 1. Potential Score filter (6+)
      filtered = filtered.filter(p => p.potentialScore >= 6);

      // 2. Launch Status filter - more flexible
      const validKeywords = ['Live', 'Development', 'Upcoming', 'Alpha', 'Beta', 'Planned', 'Launched', 'Launch', 'making', 'Playable'];
      // A simple regex to catch statuses that are primarily dates or quarters like '2025-08-31' or '2025-Q3'
      const dateLikeRegex = /^\d{4}[-Q]/;

      filtered = filtered.filter(p => {
          if (!p.launchStatus || p.launchStatus === 'N/A') {
              return false;
          }
          const lowerStatus = p.launchStatus.toLowerCase();
          const hasKeyword = validKeywords.some(keyword => lowerStatus.includes(keyword.toLowerCase()));
          const isDateLike = dateLikeRegex.test(p.launchStatus);
          return hasKeyword || isDateLike;
      });

      // 3. Website filter (not N/A) - REMOVED to include early-stage projects

      // 4. Category filter
      const targetCategories = ['GameFi', 'DeFi', 'DePIN', 'NFT', 'AI', 'Metaverse'];
      filtered = filtered.filter(p => {
        if (!p.categoryTags || p.categoryTags === 'N/A') return false;
        return targetCategories.some(cat => p.categoryTags.includes(cat));
      });

      return filtered;
  }

  private prioritizeProjects(projects: Project[]): Project[] {
      const prioritized = projects.map(p => {
          const priorityScore = (p.potentialScore * 0.4) + 
                                (this.calculateLaunchPriority(p) * 0.3) +
                                (this.calculateCategoryPriority(p) * 0.3);
          return { ...p, priorityScore };
      });

      return prioritized.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
  }
  
  private calculateLaunchPriority(project: Project): number {
    const lowerStatus = project.launchStatus.toLowerCase();
    if (lowerStatus.includes('upcoming')) return 10.0;
    if (lowerStatus.includes('development') || lowerStatus.includes('making')) return 8.0;
    if (lowerStatus.includes('early access') || lowerStatus.includes('alpha') || lowerStatus.includes('beta')) return 7.0;
    if (lowerStatus.includes('live') || lowerStatus.includes('launched') || lowerStatus.includes('playable')) return 5.0;
    return 3.0;
  }

  private calculateCategoryPriority(project: Project): number {
      const highPriority = ['GameFi', 'DePIN', 'AI'];
      const mediumPriority = ['DeFi', 'NFT', 'Metaverse'];
      if (highPriority.some(cat => project.categoryTags.includes(cat))) return 10.0;
      if (mediumPriority.some(cat => project.categoryTags.includes(cat))) return 7.0;
      return 5.0;
  }

  private generateSummaryStats(projects: Project[]): SummaryStatistics {
    const totalProjects = projects.length;
    const averagePotentialScore = totalProjects > 0 ? projects.reduce((sum, p) => sum + p.potentialScore, 0) / totalProjects : 0;
    const highPotentialProjects = projects.filter(p => p.potentialScore >= 8).length;
    const mediumPotentialProjects = projects.filter(p => p.potentialScore >= 6 && p.potentialScore < 8).length;
    const upcomingProjects = projects.filter(p => p.launchStatus.toLowerCase().includes('upcoming')).length;
    
    return {
      totalProjects,
      averagePotentialScore: parseFloat(averagePotentialScore.toFixed(2)),
      highPotentialProjects,
      mediumPotentialProjects,
      upcomingProjects
    };
  }

  private analyzeCategories(projects: Project[]): ChartData[] {
    const counts: { [key: string]: number } = {};
    projects.forEach(p => {
      p.categoryTags.split(',').forEach(cat => {
        const trimmedCat = cat.trim();
        if (trimmedCat) {
          counts[trimmedCat] = (counts[trimmedCat] || 0) + 1;
        }
      });
    });
    return Object.entries(counts)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }

  private analyzeLaunchStatus(projects: Project[]): ChartData[] {
     const counts: { [key: string]: number } = {};
     projects.forEach(p => {
        counts[p.launchStatus] = (counts[p.launchStatus] || 0) + 1;
     });
     return Object.entries(counts).map(([label, value]) => ({ label, value }));
  }

  private analyzePotentialScores(projects: Project[]): ChartData[] {
      const counts: { [key: string]: number } = {};
      projects.forEach(p => {
        const score = Math.floor(p.potentialScore).toString();
        counts[score] = (counts[score] || 0) + 1;
      });
      return Object.entries(counts).map(([label, value]) => ({ label: `${label}.x`, value })).sort((a, b) => parseFloat(a.label) - parseFloat(b.label));
  }
}
