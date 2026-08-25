import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Alert,
  Share,
  ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { groupsAPI, GroupMember } from '../../api/groups';
import { alertsAPI } from '../../api/alerts';
import { colors, spacing, borderRadius, fontSize } from '../../utils/theme';
import { MainStackParamList } from '../../navigation/MainNavigator';
import * as Haptics from 'expo-haptics';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'GroupDetail'>;
  route: RouteProp<MainStackParamList, 'GroupDetail'>;
};

export function GroupDetailScreen({ navigation, route }: Props) {
  const { groupId, groupName } = route.params;
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [inviteCode, setInviteCode] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [sendingAlert, setSendingAlert] = useState(false);

  useEffect(() => {
    loadGroupDetails();
  }, []);

  const loadGroupDetails = async () => {
    try {
      const [membersData, inviteData] = await Promise.all([
        groupsAPI.getGroupMembers(groupId),
        groupsAPI.getInviteCode(groupId),
      ]);
      setMembers(membersData);
      setInviteCode(inviteData.inviteCode);
    } catch (error) {
      console.error('Failed to load group details:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleShareInvite = async () => {
    try {
      await Share.share({
        message: `Join my WorkAlert group "${groupName}"!\n\nInvite Code: ${inviteCode}\n\nDownload WorkAlert and use this code to join.`,
      });
    } catch (error) {
      console.error('Error sharing:', error);
    }
  };

  const handleSendAlert = async () => {
    setSendingAlert(true);
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      await alertsAPI.sendAlert(groupId);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Alert Sent!', 'All group members have been alerted.');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to send alert';
      Alert.alert('Error', message);
    } finally {
      setSendingAlert(false);
    }
  };

  const handleLeaveGroup = () => {
    Alert.alert(
      'Leave Group',
      `Are you sure you want to leave "${groupName}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              await groupsAPI.leaveGroup(groupId);
              navigation.goBack();
            } catch (error: any) {
              Alert.alert('Error', 'Failed to leave group');
            }
          },
        },
      ]
    );
  };

  const renderMember = ({ item }: { item: GroupMember }) => (
    <View style={styles.memberCard}>
      <View style={styles.memberAvatar}>
        <Text style={styles.memberAvatarText}>
          {item.name.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.memberInfo}>
        <Text style={styles.memberName}>{item.name}</Text>
        <Text style={styles.memberEmail}>{item.email}</Text>
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Invite Code Section */}
      <View style={styles.inviteSection}>
        <Text style={styles.inviteLabel}>Invite Code</Text>
        <Text style={styles.inviteCode}>{inviteCode}</Text>
        <TouchableOpacity style={styles.shareButton} onPress={handleShareInvite}>
          <Text style={styles.shareButtonText}>Share Invite</Text>
        </TouchableOpacity>
      </View>

      {/* Alert Button */}
      <TouchableOpacity
        style={[styles.alertButton, sendingAlert && styles.alertButtonDisabled]}
        onPress={handleSendAlert}
        disabled={sendingAlert}
        activeOpacity={0.7}
      >
        <Text style={styles.alertButtonText}>
          {sendingAlert ? 'Sending...' : '🚨 Send Alert to Group'}
        </Text>
      </TouchableOpacity>

      {/* Members */}
      <Text style={styles.sectionTitle}>
        Members ({members.length})
      </Text>
      <FlatList
        data={members}
        renderItem={renderMember}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.membersList}
      />

      {/* Leave Group */}
      <TouchableOpacity style={styles.leaveButton} onPress={handleLeaveGroup}>
        <Text style={styles.leaveButtonText}>Leave Group</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  inviteSection: {
    alignItems: 'center',
    padding: spacing.lg,
    backgroundColor: colors.surface,
    margin: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  inviteLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  inviteCode: {
    fontSize: fontSize.xxl,
    fontWeight: 'bold',
    color: colors.primary,
    letterSpacing: 3,
    marginBottom: spacing.md,
  },
  shareButton: {
    backgroundColor: colors.surfaceLight,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  shareButtonText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  alertButton: {
    backgroundColor: colors.primary,
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  alertButtonDisabled: {
    opacity: 0.6,
  },
  alertButtonText: {
    color: '#ffffff',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  sectionTitle: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  membersList: {
    paddingHorizontal: spacing.md,
  },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: borderRadius.sm,
    marginBottom: spacing.sm,
  },
  memberAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.secondary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  memberAvatarText: {
    color: '#ffffff',
    fontSize: fontSize.md,
    fontWeight: 'bold',
  },
  memberInfo: {
    flex: 1,
  },
  memberName: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
  },
  memberEmail: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  leaveButton: {
    margin: spacing.md,
    padding: spacing.md,
    alignItems: 'center',
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.error,
  },
  leaveButtonText: {
    color: colors.error,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
});
