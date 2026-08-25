import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { Platform, Vibration } from 'react-native';

let alarmSound: Audio.Sound | null = null;
let isPlaying = false;

// Strong vibration pattern: long bursts with short pauses
const STRONG_VIBRATION_PATTERN = [
  0, 1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000,
  200, 1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000,
];

export async function playAlarmSound(): Promise<void> {
  if (isPlaying) return;

  try {
    // Configure audio for alarm behavior
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });

    // Load and play alarm sound
    const { sound } = await Audio.Sound.createAsync(
      require('../../assets/alarm.wav'),
      {
        isLooping: true,
        volume: 1.0,
        shouldPlay: true,
      }
    );

    alarmSound = sound;
    isPlaying = true;

    // Start strong vibration
    startStrongVibration();

    // Auto-stop after 30 seconds
    setTimeout(() => {
      stopAlarm();
    }, 30000);
  } catch (error) {
    console.error('Error playing alarm:', error);
    // Fallback: just vibrate
    startStrongVibration();
  }
}

export function startStrongVibration(): void {
  // Use repeated pattern vibration
  Vibration.vibrate(STRONG_VIBRATION_PATTERN, true);

  // Also use Haptics for additional feedback
  if (Platform.OS === 'ios') {
    const interval = setInterval(() => {
      if (!isPlaying) {
        clearInterval(interval);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }, 500);
  }
}

export async function stopAlarm(): Promise<void> {
  isPlaying = false;

  // Stop vibration
  Vibration.cancel();

  // Stop sound
  if (alarmSound) {
    try {
      await alarmSound.stopAsync();
      await alarmSound.unloadAsync();
    } catch (error) {
      console.error('Error stopping alarm:', error);
    }
    alarmSound = null;
  }
}

export function isAlarmPlaying(): boolean {
  return isPlaying;
}
