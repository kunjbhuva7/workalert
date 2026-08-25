import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { Vibration } from 'react-native';

export const BACKGROUND_NOTIFICATION_TASK = 'BACKGROUND-NOTIFICATION-TASK';

// Register background task for handling notifications when app is killed/background
TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error('Background notification task error:', error);
    return;
  }

  if (data) {
    const notification = data as any;
    const alertType = notification?.body?.data?.type;

    if (alertType === 'WORK_ALERT') {
      // Trigger strong vibration pattern
      Vibration.vibrate(
        [0, 1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000],
        true
      );

      // Show a high-priority local notification with alarm sound
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '🚨 WORK ALERT!',
          body: notification?.body?.data?.message || 'Someone needs your attention!',
          sound: 'alarm.wav',
          priority: Notifications.AndroidNotificationPriority.MAX,
          vibrate: [0, 1000, 200, 1000, 200, 1000],
          data: { type: 'WORK_ALERT' },
        },
        trigger: null, // Immediate
      });

      // Auto-stop vibration after 15 seconds
      setTimeout(() => {
        Vibration.cancel();
      }, 15000);
    }
  }
});

// Register the background notification task
export function registerBackgroundNotificationTask() {
  Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
}
