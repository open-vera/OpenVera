import { Router, Request, Response } from 'express';
import { vera_api_call } from '../utils/vera-api.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const data = await vera_api_call('/agent-admin-api/status', { type: 'heat_distribution' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch heatmap data' });
  }
});

export default router;