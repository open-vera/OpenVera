export async function vera_api_call(path: string, params: any): Promise<any> {
  // Mock implementation for now
  console.log(`Mock vera_api_call: ${path}`, params);

  if (path === '/agent-admin-api/status') {
    if (params.type === 'overview') {
      return {
        total_spaces: 10,
        running_tasks: 3,
        active_workers: 5,
        total_resources: { cpu: '16 cores', memory: '32GB', disk: '500GB' },
        used_resources: { cpu: '6 cores', memory: '12GB', disk: '200GB' }
      };
    } else if (params.type === 'containers') {
      return [
        { scope_id: 'group_123', type: 'group', busy: true, running_task_id: 'task-123' },
        { scope_id: 'user_456', type: 'user', busy: false, running_task_id: null },
        { scope_id: 'group_789', type: 'group', busy: false, running_task_id: null }
      ];
    } else if (params.type === 'system_resources') {
      return {
        cpu: { total: 16, used: 6, percentage: 37.5 },
        memory: { total: 32768, used: 12288, percentage: 37.5 },
        disk: { total: 500 * 1024 * 1024 * 1024, used: 200 * 1024 * 1024 * 1024, percentage: 40 }
      };
    } else if (params.type === 'heat_distribution') {
      return Array(24).fill(0).map((_, i) => ({
        hour: i,
        active_containers: Math.floor(Math.random() * 10)
      }));
    }
  }

  return { status: 'ok', data: {} };
}
