"use client";
import type { ChannelId } from "@catalog/core/catalog/types";
import ChannelPicker from "./ChannelPicker";
export default function WizardStep3({channels,onChange}:{channels:ChannelId[];onChange(value:ChannelId[]):void}){
 return <section><h2>Where will these images go?</h2><p>Tick every marketplace you want images for. Each one is made to that marketplace's own rules. Nothing is pre-selected.</p><ChannelPicker channels={channels} onChange={onChange}/></section>;
}
