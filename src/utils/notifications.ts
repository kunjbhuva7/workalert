import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { authAPI } from '../api/auth';

export async function setupNotifications() {
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device');
    return;
  }

  // Set up notification channel for Android (alarm priority)
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('workalert-alarm', {
      name: 'WorkAlert Alarms',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 200, 500, 200, 500, 200, 500],
      sound: 'alarm.wav',
      enableLights: true,
      lightColor: '#e94560',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });

    await Notifications.setNotificationChannelAsync('workalert-default', {
      name: 'WorkAlert Notifications',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      sound: undefined,
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Failed to get push notification permissions');
    return;
  }

  const tokenData = await Notifications.getExpoPushTokenAsync();

  // Also get FCM token for direct FCM
  let fcmToken: string | undefined;
  try {
    const deviceToken = await Notifications.getDevicePushTokenAsync();
    fcmToken = deviceToken.data as string;
  } catch (e) {
    console.log('Could not get device push token:', e);
  }

  // Send push token to backend
  const pushToken = fcmToken || tokenData.data;
  try {
    await authAPI.updatePushToken(pushToken);
  } catch (error) {
    console.log('Failed to update push token on server:', error);
  }

  return pushToken;
}

export async function registerForPushNotificationsAsync(): Promise<string | undefined> {
  if (!Device.isDevice) {
    return undefined;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return undefined;
  }

  try {
    const deviceToken = await Notifications.getDevicePushTokenAsync();
    return deviceToken.data as string;
  } catch {
    const expoToken = await Notifications.getExpoPushTokenAsync();
    return expoToken.data;
  }
}
