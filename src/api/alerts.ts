import apiClient from './client';

export interface Alert {
  id: string;
  groupId: string;
  groupName: string;
  sentBy: string;
  sentByName: string;
  message: string;
  createdAt: string;
}

export const alertsAPI = {
  sendAlert: async (groupId: string, message?: string): Promise<Alert> => {
    const response = await apiClient.post('/api/alerts/send', {
      groupId,
      message: message || 'ALERT! Check in now!',
    });
    return response.data;
  },

  getAlertHistory: async (groupId?: string): Promise<Alert[]> => {
    const params = groupId ? { groupId } : {};
    const response = await apiClient.get('/api/alerts/history', { params });
    return response.data;
  },
};
