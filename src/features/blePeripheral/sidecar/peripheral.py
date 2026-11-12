"""Bumble peripheral owned by one AutoMobile session. Stdout is JSON lines only."""

import asyncio
import json
import sys

# Stdin EOF is only watched once the transport is open, so a hung open must end on its own.
OPEN_TRANSPORT_TIMEOUT_S = 20


def emit(event, command_id=None, **fields):
    print(json.dumps({"event": event, **({"id": command_id} if command_id is not None else {}), **fields}), flush=True)


async def open_transport_bounded(opener, spec, timeout_s=OPEN_TRANSPORT_TIMEOUT_S):
    # TimeoutError has an empty message, which would surface as a bare "BLE sidecar: ".
    try:
        return await asyncio.wait_for(opener(spec), timeout_s)
    except asyncio.TimeoutError:
        raise TimeoutError(f"Timed out after {timeout_s} s opening BLE transport {spec}") from None


def decode_value(value):
    return bytes.fromhex(value["value"]) if value.get("encoding") == "hex" else value["value"].encode("utf-8")


async def main():
    # Imports stay inside the error boundary so a damaged venv reports a protocol error.
    from bumble.device import Device
    from bumble.transport import open_transport
    from bumble.core import AdvertisingData, UUID
    from bumble.gatt import Service, Characteristic
    from bumble.profiles.battery_service import BatteryService
    from bumble.profiles.heart_rate_service import HeartRateService
    from bumble.hci import Address

    config_line = await asyncio.to_thread(sys.stdin.readline)
    if not config_line:
        return
    config = json.loads(config_line)
    transport = await open_transport_bounded(open_transport, config["transport"])
    async with transport as (source, sink):
        device = Device.with_hci(config["name"], Address(config["address"]), source, sink)
        level = [87]
        heart_rate = [72]
        services = []
        characteristics = {}
        battery = None
        if "battery" in config["presets"]:
            # BatteryService reads and notifies through its callback, not characteristic.value.
            battery = BatteryService(lambda _: level[0])
            services.append(battery)
            characteristics["battery"] = battery.battery_level_characteristic
        if "heartRate" in config["presets"]:
            heart = HeartRateService(read_heart_rate_measurement=lambda _: HeartRateService.HeartRateMeasurement(heart_rate[0]))
            services.append(heart)
            characteristics["heartRate"] = heart.heart_rate_measurement_characteristic
        for service in config.get("services") or []:
            custom = []
            for spec in service["characteristics"]:
                properties = Characteristic.Properties(0)
                if "read" in spec["properties"]:
                    properties |= Characteristic.Properties.READ
                if "notify" in spec["properties"]:
                    properties |= Characteristic.Properties.NOTIFY
                characteristic = Characteristic(spec["uuid"], properties, Characteristic.READABLE if "read" in spec["properties"] else 0, decode_value(spec["initialValue"]) if "initialValue" in spec else b"")
                key = str(UUID(spec["uuid"]))
                if key in characteristics:
                    raise ValueError("Duplicate custom characteristic UUID")
                characteristics[key] = characteristic
                custom.append(characteristic)
            services.append(Service(service["uuid"], custom))
        device.add_services(services)
        connections = {}
        subscriptions = set()

        def status():
            return {"running": True, "advertising": not connections and bool(device.is_advertising), "connected": list(connections.values()), "subscribed": sorted({uuid for _, uuid in subscriptions}), "pythonReady": True, "bumbleReady": True}

        def on_connection(connection):
            connections[connection.handle] = str(connection.peer_address)
            emit("connected", status=status())

            def on_disconnection(_reason):
                connections.pop(connection.handle, None)
                subscriptions.difference_update({entry for entry in subscriptions if entry[0] == connection.handle})
                emit("disconnected", status=status())

            connection.on("disconnection", on_disconnection)

        def on_subscription(bearer, characteristic, notify_enabled, indicate_enabled):
            connection = getattr(bearer, "connection", bearer)
            entry = (connection.handle, str(characteristic.uuid))
            if notify_enabled or indicate_enabled:
                subscriptions.add(entry)
            else:
                subscriptions.discard(entry)

        device.on("connection", on_connection)
        device.on("characteristic_subscription", on_subscription)
        await device.power_on()
        advertising = [(AdvertisingData.COMPLETE_LOCAL_NAME, config["name"].encode("utf-8"))]
        preset_uuids = b""
        if battery:
            preset_uuids += bytes([0x0F, 0x18])
        if "heartRate" in config["presets"]:
            preset_uuids += bytes([0x0D, 0x18])
        if preset_uuids:
            advertising.append((AdvertisingData.INCOMPLETE_LIST_OF_16_BIT_SERVICE_CLASS_UUIDS, preset_uuids))
        device.advertising_data = bytes(AdvertisingData(advertising))
        # A connection pauses advertising; restart after disconnection.
        await device.start_advertising(auto_restart=True)
        emit("advertising", status=status())
        emit("ready", status=status())
        while line := await asyncio.to_thread(sys.stdin.readline):
            command = {}
            try:
                command = json.loads(line)
                action = command["action"]
                if action == "stop":
                    emit("stopped", command.get("id"))
                    return
                if action == "status":
                    emit("status", command["id"], status=status())
                    continue
                if action != "notify":
                    raise ValueError("Unknown sidecar action")
                key = command["characteristic"]
                if key not in ("battery", "heartRate"):
                    key = str(UUID(key))
                characteristic = characteristics[key]
                if not characteristic.properties & Characteristic.Properties.NOTIFY:
                    raise ValueError("Characteristic does not support notify")
                if key == "battery":
                    if not 0 <= command["level"] <= 100:
                        raise ValueError("Battery level must be 0-100")
                    level[0] = command["level"]
                elif key == "heartRate":
                    heart_rate[0] = command["bpm"]
                else:
                    characteristic.value = decode_value(command["value"])
                await device.notify_subscribers(characteristic)
                emit("notified", command["id"], status=status())
            except Exception as error:
                emit("error", command.get("id"), message=str(error))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        emit("error", message=str(error))
        sys.exit(1)
