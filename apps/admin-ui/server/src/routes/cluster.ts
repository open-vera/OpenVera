import { Router, Request, Response } from 'express';
import { vera_api_call } from '../utils/vera-api.js';

const router = Router();

router.get('/overview', async (req: Request, res: Response) => {
  try {
    const data = await vera_api_call('/agent-admin-api/status', { type: 'overview' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch cluster overview' });
  }
});

router.get('/containers', async (req: Request, res: Response) => {
  try {
    const data = await vera_api_call('/agent-admin-api/status', { type: 'containers' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch containers' });
  }
});

router.get('/resources', async (req: Request, res: Response) => {
  try {
    const data = await vera_api_call('/agent-admin-api/status', { type: 'system_resources' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch system resources' });
  }
});

export default router;
