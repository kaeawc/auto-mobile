export const validGfxinfoOutput = `
        50th percentile: 8.5ms
        90th percentile: 12.3ms
        95th percentile: 15.7ms
        99th percentile: 22.1ms
        Total frames rendered: 120
        Number Missed Vsync: 5
        Number Slow UI thread: 3
        Number Frame deadline missed: 2
      `;

// API 36 emulator capture from issue #11659; process has no view roots.
export const noFrameGfxinfoOutput = `** Graphics info for pid 1745 [com.google.android.providers.media.module] **
Profile data in ms:
View hierarchy:
Total ViewRootImpl   : 0
Total attached Views : 0`;
