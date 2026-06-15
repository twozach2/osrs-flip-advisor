package com.osrsflipadvisor;

import net.runelite.client.RuneLite;
import net.runelite.client.externalplugins.ExternalPluginManager;

public class FlipAdvisorTrackerPluginTest
{
    public static void main(String[] args) throws Exception
    {
        ExternalPluginManager.loadBuiltin(FlipAdvisorTrackerPlugin.class);
        RuneLite.main(args);
    }
}
