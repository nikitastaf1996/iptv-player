package com.iptvplayer.app

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Tiny bridge between JS and native for Picture-in-Picture control.
 *
 * JS calls [setVideoActive] every time playback starts or stops so that
 * [MainActivity.onUserLeaveHint] knows whether auto-entering PiP is wanted.
 */
class PiPModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PiPModule"

    @ReactMethod
    fun setVideoActive(active: Boolean) {
        MainActivity.videoActive = active
    }

    @ReactMethod
    fun enterPiP() {
        val activity = getCurrentActivity() as? MainActivity ?: return
        activity.enterPiPIfNeeded()
    }

    // ---------- addListener / removeListeners are required by RN event emitters
    @ReactMethod
    fun addListener(eventName: String?) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
