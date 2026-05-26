import { Router, Request, Response } from 'express';

const router = Router();

// TODO: Implement vera_api_call integration in Phase 2
router.get('/overview', async (req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Cluster overview endpoint (mock)' });
});

router.get('/containers', async (req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Containers endpoint (mock)' });
});

router.get('/resources', async (req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'System resources endpoint (mock)' });
});

export default router;
