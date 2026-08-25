import apiClient from './client';

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
}

export const authAPI = {
  login: async (email: string): Promise<AuthResponse> => {
    const response = await apiClient.post('/api/auth/login', { email });
    return response.data;
  },

  signup: async (email: string, name: string): Promise<AuthResponse> => {
    const response = await apiClient.post('/api/auth/signup', { email, name });
    return response.data;
  },

  verifyToken: async (): Promise<{ user: AuthResponse['user'] }> => {
    const response = await apiClient.get('/api/auth/verify');
    return response.data;
  },

  updatePushToken: async (pushToken: string): Promise<void> => {
    await apiClient.post('/api/auth/push-token', { pushToken });
  },

  logout: async (): Promise<void> => {
    await apiClient.post('/api/auth/logout');
  },
};
