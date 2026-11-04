/**
 * Demo workspace data — embedded files for the browser dev mode.
 *
 * FRONTEND-ZERO: workspace = local directory, managed by frontend.
 * In browser dev mode we use a mock filesystem with embedded demo data.
 * In Electron mode, files are read directly from the local filesystem via IPC.
 */

/** All demo workspace files keyed by workspace-relative path. */
export const DEMO_FILES: Record<string, string> = {
  // ── Results ──
  'results/features.csv': [
    'row,column,value,feature,protein',
    'Sample1,Feature01,12.5,FEAT001,PROT_A',
    'Sample1,Feature02,8.3,FEAT002,PROT_B',
    'Sample1,Feature03,15.7,FEAT003,PROT_C',
    'Sample1,Feature04,3.2,FEAT004,PROT_A',
    'Sample1,Feature05,9.1,FEAT005,PROT_D',
    'Sample2,Feature01,11.8,FEAT001,PROT_A',
    'Sample2,Feature02,7.9,FEAT002,PROT_B',
    'Sample2,Feature03,16.2,FEAT003,PROT_C',
    'Sample2,Feature04,2.8,FEAT004,PROT_A',
    'Sample2,Feature05,9.8,FEAT005,PROT_D',
    'Sample3,Feature01,14.2,FEAT001,PROT_A',
    'Sample3,Feature02,6.1,FEAT002,PROT_B',
    'Sample3,Feature03,18.5,FEAT003,PROT_C',
    'Sample3,Feature04,4.1,FEAT004,PROT_A',
    'Sample3,Feature05,7.3,FEAT005,PROT_D',
  ].join('\n'),

  'results/intensities.csv': [
    'sample,feature,intensity,retention_time,mass',
    'Sample1,SIG_A,125000,12.5,500.25',
    'Sample1,SIG_B,83000,14.2,750.80',
    'Sample1,SIG_C,157000,10.1,600.10',
    'Sample1,SIG_D,32000,18.7,820.45',
    'Sample2,SIG_A,118000,12.6,500.25',
    'Sample2,SIG_B,79000,14.1,750.80',
    'Sample2,SIG_C,162000,10.0,600.10',
    'Sample2,SIG_D,28000,18.8,820.45',
    'Sample3,SIG_A,142000,12.4,500.25',
    'Sample3,SIG_B,61000,14.3,750.80',
    'Sample3,SIG_C,185000,9.9,600.10',
    'Sample3,SIG_D,41000,18.6,820.45',
  ].join('\n'),

  'results/qc_stats.csv': [
    'sample,log2_fc,p_value,feature,protein',
    'A,1.25,0.012,FEAT001,PROT_A',
    'A,-0.85,0.045,FEAT002,PROT_B',
    'A,2.10,0.003,FEAT003,PROT_C',
    'A,-0.32,0.320,FEAT004,PROT_A',
    'A,1.05,0.021,FEAT005,PROT_D',
    'B,1.15,0.015,FEAT001,PROT_A',
    'B,-0.95,0.038,FEAT002,PROT_B',
    'B,2.30,0.002,FEAT003,PROT_C',
    'B,-0.45,0.280,FEAT004,PROT_A',
    'B,1.20,0.018,FEAT005,PROT_D',
    'C,1.35,0.010,FEAT001,PROT_A',
    'C,-0.75,0.055,FEAT002,PROT_B',
    'C,1.90,0.004,FEAT003,PROT_C',
    'C,-0.28,0.350,FEAT004,PROT_A',
    'C,0.95,0.025,FEAT005,PROT_D',
  ].join('\n'),

  // ── Views ──
  'views/heatmap-features.json': JSON.stringify({
    id: 'heatmap-features',
    title: 'Feature Intensity Heatmap',
    viewer: 'heatmap',
    version: 1,
    inputs: [{ path: 'results/features.csv', kind: 'feature_table' }],
    params: { colorScheme: 'viridis', showRowLabels: true, showColumnLabels: true },
  }),

  'views/feature-table.json': JSON.stringify({
    id: 'feature-table',
    title: 'Feature Table',
    viewer: 'table',
    version: 1,
    inputs: [{ path: 'results/features.csv', kind: 'table' }],
    params: { pageSize: 25, enableSelection: true },
  }),

  'views/qc-scatter.json': JSON.stringify({
    id: 'qc-scatter',
    title: 'QC Scatter (Log2 FC vs P-value)',
    viewer: 'scatter',
    version: 1,
    inputs: [{ path: 'results/qc_stats.csv', kind: 'table' }],
    params: { colorScheme: 'viridis', showLegend: true },
    mapping: { x: 'log2_fc', y: 'p_value' },
  }),

  'views/intensity-spectrum.json': JSON.stringify({
    id: 'spectrum-intensities',
    title: 'Intensity Spectrum',
    viewer: 'spectrum',
    version: 1,
    inputs: [{ path: 'results/intensities.csv', kind: 'peak_table' }],
    params: { normalizeIntensity: true, showPeaks: true },
    mapping: { mzColumn: 'mass', intensityColumn: 'intensity' },
  }),

  'views/dashboard.json': JSON.stringify({
    id: 'demo-dashboard',
    title: 'Demo Dashboard',
    cards: [
      { ref: 'heatmap-features', position: { x: 0, y: 0, w: 6, h: 5 } },
      { ref: 'feature-table', position: { x: 6, y: 0, w: 6, h: 3 } },
      { ref: 'qc-scatter', position: { x: 6, y: 3, w: 6, h: 4 } },
      { ref: 'spectrum-intensities', position: { x: 0, y: 5, w: 12, h: 4 } },
    ],
  }),
}
