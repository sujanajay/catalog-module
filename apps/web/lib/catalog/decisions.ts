import { applyDecision, CatalogDecisionError, completeReplacement,startReplacement } from "@catalog/core/catalog/decisions";
import { enqueueTask } from "@catalog/core/tasks";
import * as storage from "@catalog/core/storage";
import { db } from "../db";
import { HttpError } from "../errors";
export async function decisionAction<T>(action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){if(error instanceof CatalogDecisionError)throw new HttpError(error.status,error.message);throw error;}}
export async function decidePhoto(outputId:string,decision:"use_as_is"|"remove",actor:string){
 return decisionAction(async()=>{const result=await applyDecision(db(),{outputId,decision,actor});await enqueueTask("/tasks/catalog/publish",{batchId:result.batchId,productId:result.productId,trigger:result.decisionId},{taskId:`publish-${result.productId}-${result.decisionId}`});return result;});
}
export async function replacementUpload(outputId:string,input:{name:string;size:number;mime:string}){
 return decisionAction(()=>startReplacement({db:db(),storage},{outputId,...input}));
}
export async function finishReplacement(outputId:string,uploadId:string,actor:string){
 return decisionAction(async()=>{const result=await completeReplacement({db:db(),storage},{outputId,uploadId,actor});await enqueueTask("/tasks/catalog/chunk",{chunkId:result.chunkId},{taskId:`chunk-${result.chunkId}-matte`});return result;});
}
