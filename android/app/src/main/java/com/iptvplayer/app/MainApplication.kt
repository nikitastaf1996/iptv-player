package com.iptvplayer.app

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    val packageList = PackageList(this).packages
    // Register our hand-written PiP module so JS can import NativeModules.PiPModule.
    packageList.add(PiPPackage())
    getDefaultReactHost(
      context = applicationContext,
      packageList = packageList,
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
