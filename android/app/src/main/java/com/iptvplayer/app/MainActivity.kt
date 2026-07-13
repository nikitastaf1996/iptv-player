package com.iptvplayer.app

import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    companion object {
        /**
         * Flag toggled from JS via [PiPModule.setVideoActive]. While true,
         * pressing the home button (or otherwise leaving the activity) will
         * auto-enter Picture-in-Picture so the stream keeps playing.
         */
        @JvmStatic
        var videoActive: Boolean = false
    }

    override fun getMainComponentName(): String = "iptvplayer"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    /**
     * Called when the user chooses to leave this activity (e.g. presses Home).
     * If a stream is currently playing we slide into PiP instead of going to
     * the recents list.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (videoActive) {
            enterPiPIfNeeded()
        }
    }

    fun enterPiPIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        if (isInPictureInPictureMode) return
        try {
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        setAutoEnterEnabled(true)
                        setSeamlessResizeEnabled(true)
                    }
                }
                .build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                enterPictureInPictureMode(params)
            } else {
                @Suppress("DEPRECATION")
                enterPictureInPictureMode()
            }
        } catch (e: Exception) {
            // Some OEMs throw if PiP isn't allowed in the current state — ignore.
        }
    }
}
