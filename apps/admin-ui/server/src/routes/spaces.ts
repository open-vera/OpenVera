import { Router, Request, Response } from 'express';
import { vera_api_call } from '../utils/vera-api.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const [containers, overview] = await Promise.all([
      vera_api_call('/agent-admin-api/status', { type: 'containers' }),
      vera_api_call('/agent-admin-api/status', { type: 'overview' })
    ]);

    // Aggregate spaces data
    const spaces = containers.map((container: any) => ({
      scope_id: container.scope_id,
      type: container.type,
      busy: container.busy,
      running_task_id: container.running_task_id
    }));

    res.json(spaces);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch spaces' });
  }
});

router.get('/:scopeId', async (req: Request, res: Response) => {
  try {
    const { scopeId } = req.params;
    const data = await vera_api_call('/agent-admin-api/status', {
      type: 'space_detail',
      scope_id: scopeId
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch space details' });
  }
});

export default router;