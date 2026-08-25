import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  RefreshControl,
  Alert,
  Animated,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../../context/AuthContext';
import { groupsAPI, Group } from '../../api/groups';
import { alertsAPI } from '../../api/alerts';
import { colors, spacing, borderRadius, fontSize } from '../../utils/theme';
import { MainStackParamList } from '../../navigation/MainNavigator';
import * as Haptics from 'expo-haptics';

type NavigationProp = NativeStackNavigationProp<MainStackParamList>;

export function HomeScreen() {
  const { user } = useAuth();
  const navigation = useNavigation<NavigationProp>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [sendingAlert, setSendingAlert] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const pulseAnim = useState(new Animated.Value(1))[0];

  useEffect(() => {
    loadGroups();
    startPulseAnimation();
  }, []);

  const startPulseAnimation = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.05,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  };

  const loadGroups = async () => {
    try {
      const data = await groupsAPI.getMyGroups();
      setGroups(data);
      if (data.length > 0 && !selectedGroup) {
        setSelectedGroup(data[0]);
      }
    } catch (error) {
      console.error('Failed to load groups:', error);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadGroups();
    setRefreshing(false);
  }, []);

  const handleSendAlert = async () => {
    if (!selectedGroup) {
      Alert.alert('No Group Selected', 'Please select a group to send the alert to.');
      return;
    }

    Alert.alert(
      'Send Alert',
      `Send alert to "${selectedGroup.name}"? All members will be notified with alarm.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'SEND ALERT',
          style: 'destructive',
          onPress: async () => {
            setSendingAlert(true);
            try {
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              await alertsAPI.sendAlert(selectedGroup.id);
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert('Alert Sent!', `Alert sent to all members of "${selectedGroup.name}"`);
            } catch (error: any) {
              const message = error.response?.data?.message || 'Failed to send alert';
              Alert.alert('Error', message);
            } finally {
              setSendingAlert(false);
            }
          },
        },
      ]
    );
  };

  const renderGroupChip = ({ item }: { item: Group }) => (
    <TouchableOpacity
      style={[
        styles.groupChip,
        selectedGroup?.id === item.id && styles.groupChipSelected,
      ]}
      onPress={() => setSelectedGroup(item)}
      activeOpacity={0.7}
    >
      <Text
        style={[
          styles.groupChipText,
          selectedGroup?.id === item.id && styles.groupChipTextSelected,
        ]}
      >
        {item.name}
      </Text>
      <Text style={styles.memberCount}>{item.memberCount} members</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.greeting}>Hi, {user?.name || 'there'} 👋</Text>
        <Text style={styles.headerSubtext}>Ready to alert your team?</Text>
      </View>

      {/* Alert Button */}
      <View style={styles.alertSection}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            style={[styles.alertButton, sendingAlert && styles.alertButtonDisabled]}
            onPress={handleSendAlert}
            disabled={sendingAlert}
            activeOpacity={0.7}
          >
            <Text style={styles.alertButtonIcon}>🚨</Text>
            <Text style={styles.alertButtonText}>
              {sendingAlert ? 'SENDING...' : 'ALERT'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
        {selectedGroup && (
          <Text style={styles.alertTarget}>
            Alerting: {selectedGroup.name}
          </Text>
        )}
      </View>

      {/* Group Selection */}
      <View style={styles.groupSection}>
        <Text style={styles.sectionTitle}>Select Group</Text>
        {groups.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No groups yet</Text>
            <TouchableOpacity
              style={styles.createButton}
              onPress={() => navigation.navigate('CreateGroup')}
            >
              <Text style={styles.createButtonText}>Create or Join a Group</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={groups}
            renderItem={renderGroupChip}
            keyExtractor={(item) => item.id}
            horizontal={false}
            numColumns={2}
            columnWrapperStyle={styles.groupRow}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.primary}
              />
            }
            contentContainerStyle={styles.groupList}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: 60,
  },
  header: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  greeting: {
    fontSize: fontSize.xl,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  headerSubtext: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  alertSection: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  alertButton: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 12,
  },
  alertButtonDisabled: {
    opacity: 0.6,
  },
  alertButtonIcon: {
    fontSize: 40,
    marginBottom: spacing.xs,
  },
  alertButtonText: {
    color: '#ffffff',
    fontSize: fontSize.xl,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  alertTarget: {
    marginTop: spacing.md,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  groupSection: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '600',
    color: colors.text,
    marginBottom: spacing.md,
  },
  groupList: {
    paddingBottom: spacing.lg,
  },
  groupRow: {
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  groupChip: {
    flex: 0.48,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupChipSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceLight,
  },
  groupChipText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  groupChipTextSelected: {
    color: colors.primary,
  },
  memberCount: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  emptyText: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  createButton: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  createButtonText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
});
