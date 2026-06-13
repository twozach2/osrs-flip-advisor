package com.osrsflipadvisor;

import net.runelite.client.config.Config;
import net.runelite.client.config.ConfigGroup;
import net.runelite.client.config.ConfigItem;

@ConfigGroup("osrsflipadvisor")
public interface FlipAdvisorConfig extends Config
{
    @ConfigItem(
        keyName = "endpoint",
        name = "Local endpoint",
        description = "The localhost fill-ingest endpoint shown by OSRS Flip Advisor"
    )
    default String endpoint()
    {
        return "http://127.0.0.1:4173/api/ge-events";
    }

    @ConfigItem(
        keyName = "token",
        name = "Ingest token",
        description = "The local ingest token shown by OSRS Flip Advisor",
        secret = true
    )
    default String token()
    {
        return "";
    }
}
