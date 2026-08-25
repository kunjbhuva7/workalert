import apiClient from './client';

export interface Group {
  id: string;
  name: string;
  inviteCode: string;
  createdBy: string;
  memberCount: number;
  createdAt: string;
}

export interface GroupMember {
  id: string;
  email: string;
  name: string;
  joinedAt: string;
}

export const groupsAPI = {
  getMyGroups: async (): Promise<Group[]> => {
    const response = await apiClient.get('/api/groups');
    return response.data;
  },

  createGroup: async (name: string): Promise<Group> => {
    const response = await apiClient.post('/api/groups', { name });
    return response.data;
  },

  joinGroup: async (inviteCode: string): Promise<Group> => {
    const response = await apiClient.post('/api/groups/join', { inviteCode });
    return response.data;
  },

  getGroupMembers: async (groupId: string): Promise<GroupMember[]> => {
    const response = await apiClient.get(`/api/groups/${groupId}/members`);
    return response.data;
  },

  leaveGroup: async (groupId: string): Promise<void> => {
    await apiClient.post(`/api/groups/${groupId}/leave`);
  },

  deleteGroup: async (groupId: string): Promise<void> => {
    await apiClient.delete(`/api/groups/${groupId}`);
  },

  getInviteCode: async (groupId: string): Promise<{ inviteCode: string }> => {
    const response = await apiClient.get(`/api/groups/${groupId}/invite`);
    return response.data;
  },
};
