import express from 'express';
import cors from 'cors';
import clusterRouter from './routes/cluster.js';
import spacesRouter from './routes/spaces.js';
import heatmapRouter from './routes/heatmap.js';

const app = express();
const PORT = process.env.PORT || 7710;

app.use(cors());
app.use(express.json());

app.use('/api/admin', clusterRouter);
app.use('/api/admin/spaces', spacesRouter);
app.use('/api/admin/heatmap', heatmapRouter);

app.listen(PORT, () => {
  console.log(`🚀 Admin UI server running on http://localhost:${PORT}`);
  console.log('📡 Registered routes:');
  console.log('  GET /api/admin/overview');
  console.log('  GET /api/admin/containers');
  console.log('  GET /api/admin/resources');
  console.log('  GET /api/admin/spaces');
  console.log('  GET /api/admin/spaces/:scopeId');
  console.log('  GET /api/admin/heatmap');
});
