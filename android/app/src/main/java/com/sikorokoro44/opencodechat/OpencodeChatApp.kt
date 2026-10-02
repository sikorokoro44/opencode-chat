package com.sikorokoro44.opencodechat

import android.app.Application
import com.sikorokoro44.opencodechat.di.AppContainer
import com.sikorokoro44.opencodechat.di.DefaultAppContainer

class OpencodeChatApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = DefaultAppContainer(this)
    }
}
