chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'START_RECORDING') {
    startRecording(message.data.streamId);
  } else if (message.type === 'STOP_RECORDING') {
    stopRecording();
  }
});

let recorder;
let data = [];

async function startRecording(streamId) {
  if (recorder?.state === 'recording') {
    throw new Error('Called startRecording while already recording');
  }

  const media = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  // Continue to play the captured audio to the user? (If we captured audio)
  // media.getAudioTracks().forEach(track => track.enable...);

  recorder = new MediaRecorder(media, { mimeType: 'video/webm' });
  recorder.ondataavailable = (event) => data.push(event.data);
  recorder.onstop = () => {
    // Blob
    const blob = new Blob(data, { type: 'video/webm' });
    // Convert to base64
    const reader = new FileReader();
    reader.onload = () => {
      const base64Url = reader.result;
      // Send back to background
      chrome.runtime.sendMessage({
        type: 'RECORDING_DATA',
        data: base64Url
      });

      // Clear state
      recorder = undefined;
      data = [];
      // Stop all tracks
      media.getTracks().forEach(t => t.stop());
    };
    reader.readAsDataURL(blob);
  };

  recorder.start();
  // Clear buffer
  data = [];
}

function stopRecording() {
  recorder.stop();
}
