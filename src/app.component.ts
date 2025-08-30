import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, AfterViewInit, inject, signal, effect, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CsvAnalysisService } from './services/csv-analysis.service';
import { AnalysisResult, Project } from './models/analysis.model';

declare var d3: any;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule],
})
export class AppComponent implements AfterViewInit {
  @ViewChild('categoryChart') private categoryChartContainer!: ElementRef;
  @ViewChild('statusChart') private statusChartContainer!: ElementRef;
  @ViewChild('scoreChart') private scoreChartContainer!: ElementRef;

  private analysisService = inject(CsvAnalysisService);
  
  isLoading = signal(false);
  errorMessage = signal<string | null>(null);
  analysisResult = signal<AnalysisResult | null>(null);
  apiKey = signal<string | null>(null);

  hasApiKey = computed(() => !!this.apiKey());

  viewMode = computed(() => {
    if (!this.hasApiKey()) {
      return 'apiKeySetup';
    }
    return this.analysisResult() ? 'dashboard' : 'upload';
  });

  private chartsRendered = false;

  constructor() {
    const storedKey = localStorage.getItem('gemini-api-key');
    if (storedKey) {
      this.apiKey.set(storedKey);
      this.analysisService.initializeAi(storedKey);
    }
    
    effect(() => {
      if (this.analysisResult() && !this.chartsRendered) {
        setTimeout(() => this.renderCharts(), 0);
      }
    });
  }

  ngAfterViewInit() {
    if (this.analysisResult()) {
      this.renderCharts();
    }
  }
  
  saveApiKey(key: string): void {
    if (!key.trim()) {
      this.errorMessage.set('API Key cannot be empty.');
      return;
    }
    localStorage.setItem('gemini-api-key', key);
    this.apiKey.set(key);
    this.analysisService.initializeAi(key);
    this.errorMessage.set(null);
  }

  changeApiKey(): void {
    localStorage.removeItem('gemini-api-key');
    this.apiKey.set(null);
    this.resetAnalysis();
  }

  async onFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) {
      return;
    }

    const file = input.files[0];
    if (file.type !== 'text/csv') {
        this.errorMessage.set('Invalid file type. Please upload a CSV file.');
        return;
    }

    this.isLoading.set(true);
    this.errorMessage.set(null);
    this.analysisResult.set(null);
    this.chartsRendered = false;

    const fileContent = await file.text();
    
    try {
      const projects = this.analysisService.parseCsv(fileContent);
      if (projects.length === 0) {
        throw new Error("CSV file is empty or could not be parsed.");
      }
      const result = this.analysisService.analyzeData(projects);
      this.analysisResult.set(result);
    } catch (error: any) {
      this.errorMessage.set(`Error processing file: ${error.message}`);
      this.analysisResult.set(null);
    } finally {
      this.isLoading.set(false);
      input.value = ''; // Reset file input
    }
  }

  async verifyProject(projectToVerify: Project): Promise<void> {
    const currentResult = this.analysisResult();
    if (!currentResult) return;

    // Set status to 'verifying' and update the signal for immediate UI feedback
    this.updateProjectInSignal(projectToVerify.projectName, { verificationStatus: 'verifying' });

    try {
      const verificationData = await this.analysisService.verifyProject(projectToVerify);
      // Update the project with the full verification results
      this.updateProjectInSignal(projectToVerify.projectName, verificationData);
    } catch (error) {
      console.error("Verification failed", error);
      // Update the project with a 'failed' status
      this.updateProjectInSignal(projectToVerify.projectName, { verificationStatus: 'failed' });
    }
  }
  
  private updateProjectInSignal(projectName: string, updates: Partial<Project>): void {
    this.analysisResult.update(currentResult => {
      if (!currentResult) return null;
      
      const projectIndex = currentResult.prioritizedProjects.findIndex(p => p.projectName === projectName);
      if (projectIndex === -1) return currentResult;

      const updatedProjects = [...currentResult.prioritizedProjects];
      updatedProjects[projectIndex] = { ...updatedProjects[projectIndex], ...updates };

      return { ...currentResult, prioritizedProjects: updatedProjects };
    });
  }


  resetAnalysis(): void {
    this.analysisResult.set(null);
    this.errorMessage.set(null);
    this.isLoading.set(false);
    this.chartsRendered = false;
  }

  exportToCsv(): void {
    const projects = this.analysisResult()?.prioritizedProjects;
    if (!projects || projects.length === 0) return;

    const headers = Object.keys(projects[0]).join(',');
    const rows = projects.map(p => {
      // Custom serialization for complex objects
      const values = Object.values(p).map(val => {
        if (Array.isArray(val)) {
          return `"${val.map(item => item.uri || item).join('; ')}"`;
        }
        if (typeof val === 'string' && val.includes(',')) {
          return `"${val}"`;
        }
        return val;
      });
      return values.join(',');
    });
    const csvContent = `${headers}\n${rows.join('\n')}`;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8,' });
    // FIX: Changed `URL.ObjectURL` to `URL.createObjectURL` which is the correct static method.
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'alpha_filtered_projects.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  private renderCharts(): void {
    if (!this.analysisResult()) return;
    this.renderBarChart(this.categoryChartContainer, this.analysisResult()!.categoryAnalysis, '#818cf8');
    this.renderPieChart(this.statusChartContainer, this.analysisResult()!.launchStatusAnalysis);
    this.renderBarChart(this.scoreChartContainer, this.analysisResult()!.potentialScoreDistribution, '#60a5fa');
    this.chartsRendered = true;
  }

  private renderBarChart(elementRef: ElementRef, data: any[], color: string): void {
    if (!elementRef || !data || data.length === 0) return;
    const element = elementRef.nativeElement;
    d3.select(element).select('svg').remove();

    const margin = { top: 20, right: 20, bottom: 100, left: 40 };
    const width = element.clientWidth - margin.left - margin.right;
    const height = 300 - margin.top - margin.bottom;

    const svg = d3.select(element).append('svg')
        .attr('width', width + margin.left + margin.right)
        .attr('height', height + margin.top + margin.bottom)
      .append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`);
    
    const x = d3.scaleBand().range([0, width]).padding(0.1);
    const y = d3.scaleLinear().range([height, 0]);
    
    x.domain(data.map(d => d.label));
    y.domain([0, d3.max(data, d => d.value)]);
    
    svg.selectAll('.bar')
        .data(data)
      .enter().append('rect')
        .attr('class', 'bar')
        .attr('fill', color)
        .attr('x', d => x(d.label))
        .attr('width', x.bandwidth())
        .attr('y', d => y(d.value))
        .attr('height', d => height - y(d.value));

    svg.append('g')
        .attr('transform', `translate(0,${height})`)
        .call(d3.axisBottom(x))
        .selectAll('text')
          .attr('fill', '#94a3b8')
          .attr('transform', 'translate(-10,0)rotate(-45)')
          .style('text-anchor', 'end');

    svg.append('g')
        .call(d3.axisLeft(y))
        .selectAll('text')
          .attr('fill', '#94a3b8');
  }

  private renderPieChart(elementRef: ElementRef, data: any[]): void {
    if (!elementRef || !data || data.length === 0) return;
    const element = elementRef.nativeElement;
    d3.select(element).select('svg').remove();

    const width = element.clientWidth;
    const height = 300;
    const radius = Math.min(width, height) / 2 - 10;
    
    const svg = d3.select(element).append('svg')
        .attr('width', width)
        .attr('height', height)
      .append('g')
        .attr('transform', `translate(${width / 2}, ${height / 2})`);

    const color = d3.scaleOrdinal()
      .domain(data.map(d => d.label))
      .range(d3.schemeCategory10);
      
    const pie = d3.pie().value(d => d.value);
    const data_ready = pie(data);

    svg.selectAll('path')
      .data(data_ready)
      .enter()
      .append('path')
      .attr('d', d3.arc().innerRadius(0).outerRadius(radius))
      .attr('fill', d => color(d.data.label))
      .attr('stroke', '#1e293b')
      .style('stroke-width', '2px');

    svg.selectAll('text')
      .data(data_ready)
      .enter()
      .append('text')
      .text(d => d.data.label)
      .attr('transform', d => `translate(${d3.arc().innerRadius(0).outerRadius(radius).centroid(d)})`)
      .style('text-anchor', 'middle')
      .style('font-size', 12)
      .attr('fill', 'white');
  }
}
