package com.osrsflipadvisor;

import com.google.gson.Gson;
import com.google.inject.Provides;
import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import javax.inject.Inject;
import net.runelite.api.Client;
import net.runelite.api.GrandExchangeOffer;
import net.runelite.api.GrandExchangeOfferState;
import net.runelite.api.events.GrandExchangeOfferChanged;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

@PluginDescriptor(
    name = "OSRS Flip Advisor Tracker",
    description = "Sends read-only Grand Exchange fill deltas and open-offer updates to a local advisor",
    tags = {"grand exchange", "flipping", "tracking"}
)
public class FlipAdvisorTrackerPlugin extends Plugin
{
    private static final MediaType JSON = MediaType.parse("application/json");

    @Inject
    private Client client;

    @Inject
    private FlipAdvisorConfig config;

    @Inject
    private Gson gson;

    @Inject
    private OkHttpClient httpClient;

    private final Map<Integer, OfferSnapshot> slots = new HashMap<>();

    @Provides
    FlipAdvisorConfig provideConfig(ConfigManager configManager)
    {
        return configManager.getConfig(FlipAdvisorConfig.class);
    }

    @Override
    protected void startUp()
    {
        seedCurrentOffers();
    }

    @Override
    protected void shutDown()
    {
        slots.clear();
    }

    @Subscribe
    public void onGrandExchangeOfferChanged(GrandExchangeOfferChanged event)
    {
        int slot = event.getSlot();
        GrandExchangeOffer offer = event.getOffer();
        OfferSnapshot current = OfferSnapshot.from(offer);
        OfferSnapshot previous = slots.put(slot, current);

        sendOfferSnapshot(slot, current);

        if (previous == null || !previous.isSameOffer(current))
        {
            return;
        }

        int deltaQuantity = current.quantitySold - previous.quantitySold;
        int deltaSpent = current.spent - previous.spent;

        if (deltaQuantity <= 0 || deltaSpent <= 0 || !isTradeState(current.state))
        {
            return;
        }

        FillEvent fill = new FillEvent();
        fill.eventId = String.join(
            ":",
            Long.toUnsignedString(client.getAccountHash()),
            Integer.toString(slot),
            Integer.toString(current.itemId),
            Integer.toString(current.price),
            Integer.toString(current.totalQuantity),
            Integer.toString(current.quantitySold),
            Integer.toString(current.spent),
            current.state.name()
        );
        fill.account = Long.toUnsignedString(client.getAccountHash());
        fill.slot = slot;
        fill.itemId = current.itemId;
        fill.state = current.state.name();
        fill.quantitySold = current.quantitySold;
        fill.totalQuantity = current.totalQuantity;
        fill.offerPrice = current.price;
        fill.totalSpent = current.spent;
        fill.deltaQuantity = deltaQuantity;
        fill.deltaSpent = deltaSpent;
        fill.timestamp = Instant.now().toString();
        sendPayload(fill);
    }

    private void seedCurrentOffers()
    {
        slots.clear();
        GrandExchangeOffer[] offers = client.getGrandExchangeOffers();

        for (int slot = 0; slot < offers.length; slot++)
        {
            OfferSnapshot snapshot = OfferSnapshot.from(offers[slot]);
            slots.put(slot, snapshot);
            sendOfferSnapshot(slot, snapshot);
        }
    }

    private void sendOfferSnapshot(int slot, OfferSnapshot snapshot)
    {
        OfferEvent offerEvent = new OfferEvent();
        offerEvent.account = Long.toUnsignedString(client.getAccountHash());
        offerEvent.slot = slot;
        offerEvent.itemId = snapshot.itemId;
        offerEvent.state = snapshot.state.name();
        offerEvent.quantitySold = snapshot.quantitySold;
        offerEvent.totalQuantity = snapshot.totalQuantity;
        offerEvent.offerPrice = snapshot.price;
        offerEvent.timestamp = Instant.now().toString();
        sendPayload(offerEvent);
    }

    private boolean isTradeState(GrandExchangeOfferState state)
    {
        return state == GrandExchangeOfferState.BUYING
            || state == GrandExchangeOfferState.BOUGHT
            || state == GrandExchangeOfferState.CANCELLED_BUY
            || state == GrandExchangeOfferState.SELLING
            || state == GrandExchangeOfferState.SOLD
            || state == GrandExchangeOfferState.CANCELLED_SELL;
    }

    private void sendPayload(Object payload)
    {
        if (config.token().trim().isEmpty())
        {
            return;
        }

        Request request = new Request.Builder()
            .url(config.endpoint())
            .header("X-Advisor-Token", config.token().trim())
            .post(RequestBody.create(JSON, gson.toJson(payload)))
            .build();

        httpClient.newCall(request).enqueue(new Callback()
        {
            @Override
            public void onFailure(Call call, IOException exception)
            {
                // The local advisor may be stopped; a later GE event will retry naturally.
            }

            @Override
            public void onResponse(Call call, Response response)
            {
                response.close();
            }
        });
    }

    private static class OfferSnapshot
    {
        private final int itemId;
        private final int quantitySold;
        private final int totalQuantity;
        private final int price;
        private final int spent;
        private final GrandExchangeOfferState state;

        OfferSnapshot(
            int itemId,
            int quantitySold,
            int totalQuantity,
            int price,
            int spent,
            GrandExchangeOfferState state)
        {
            this.itemId = itemId;
            this.quantitySold = quantitySold;
            this.totalQuantity = totalQuantity;
            this.price = price;
            this.spent = spent;
            this.state = state;
        }

        static OfferSnapshot from(GrandExchangeOffer offer)
        {
            return new OfferSnapshot(
                offer.getItemId(),
                offer.getQuantitySold(),
                offer.getTotalQuantity(),
                offer.getPrice(),
                offer.getSpent(),
                offer.getState()
            );
        }

        boolean isSameOffer(OfferSnapshot other)
        {
            return itemId == other.itemId
                && totalQuantity == other.totalQuantity
                && price == other.price;
        }
    }

    private static class FillEvent
    {
        String eventId;
        String account;
        int slot;
        int itemId;
        String state;
        int quantitySold;
        int totalQuantity;
        int offerPrice;
        int totalSpent;
        int deltaQuantity;
        int deltaSpent;
        String timestamp;
    }

    private static class OfferEvent
    {
        final String kind = "offer";
        String account;
        int slot;
        int itemId;
        String state;
        int quantitySold;
        int totalQuantity;
        int offerPrice;
        String timestamp;
    }
}
