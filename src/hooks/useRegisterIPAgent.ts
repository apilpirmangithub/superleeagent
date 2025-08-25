import { useState, useCallback } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { createHash } from "crypto";
import { useStoryClient } from "@/lib/storyClient";
import { compressImage } from "@/lib/utils/image";
import { uploadFile, uploadJSON, extractCid, toHttps, toIpfsUri } from "@/lib/utils/ipfs";
import { sha256HexOfFile, keccakOfJson } from "@/lib/utils/crypto";
import { createLicenseTerms, DEFAULT_LICENSE_SETTINGS, STORY_CONTRACTS } from "@/lib/license/terms";
import { detectAI, fileToBuffer } from "@/services";
import type { RegisterIntent } from "@/lib/agent/engine";
import type { RegisterState } from "@/types/agents";
import type { LicenseSettings } from "@/lib/license/terms";

const SPG_COLLECTION = (process.env.NEXT_PUBLIC_SPG_COLLECTION as `0x${string}`) ||
  STORY_CONTRACTS.SPG_COLLECTION;

export function useRegisterIPAgent() {
  const { address } = useAccount();
  const { getClient } = useStoryClient();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const [registerState, setRegisterState] = useState<RegisterState>({
    status: 'idle',
    progress: 0,
    error: null,
  });

  const ensureAeneid = useCallback(async () => {
    if (chainId !== 1315) {
      try {
        await switchChainAsync({ chainId: 1315 });
      } catch (error) {
        throw new Error("Failed to switch to Aeneid network");
      }
    }
  }, [chainId, switchChainAsync]);

  const executeRegister = useCallback(async (intent: RegisterIntent, file: File, licenseSettings?: LicenseSettings) => {
    try {
      // Ensure we're on the right network
      await ensureAeneid();

      // Reset state
      setRegisterState({
        status: 'compressing',
        progress: 10,
        error: null,
      });

      // 1. Compress image
      const compressedFile = await compressImage(file);

      // 1.5. AI Detection (optional)
      let aiDetection = null;
      try {
        const buffer = await fileToBuffer(compressedFile);
        aiDetection = await detectAI(buffer);
      } catch (error) {
        console.warn('AI detection failed:', error);
      }

      setRegisterState(prev => ({
        ...prev,
        status: 'uploading-image',
        progress: 25
      }));

      // 2. Upload image to IPFS
      const imageUpload = await uploadFile(compressedFile);
      const imageCid = extractCid(imageUpload.cid || imageUpload.url);
      const imageGateway = toHttps(imageCid);
      const imageHash = await sha256HexOfFile(compressedFile);

      setRegisterState(prev => ({
        ...prev,
        status: 'creating-metadata',
        progress: 50
      }));

      // 3. Create IP metadata with AI detection info
      const ipMetadata = {
        title: intent.title || compressedFile.name,
        description: intent.prompt || "",
        image: imageGateway,
        imageHash,
        mediaUrl: imageGateway,
        mediaHash: imageHash,
        mediaType: compressedFile.type || "image/webp",
        creators: address
          ? [{ name: address, address, contributionPercent: 100 }]
          : [],
        aiMetadata: intent.prompt
          ? { prompt: intent.prompt, generator: "user", model: "rule-based" }
          : undefined,
        ...(aiDetection?.isAI && {
          tags: ["AI-generated"],
          aiGenerated: true,
          aiConfidence: aiDetection.confidence,
        }),
      };

      // 4. Upload IP metadata to IPFS
      const ipMetaUpload = await uploadJSON(ipMetadata);
      const ipMetaCid = extractCid(ipMetaUpload.cid || ipMetaUpload.url);
      const ipMetadataURI = toIpfsUri(ipMetaCid);
      const ipMetadataHash = await keccakOfJson(ipMetadata);

      setRegisterState(prev => ({
        ...prev,
        status: 'uploading-metadata',
        progress: 60
      }));

      // 5. Create NFT metadata with license info
      const usedLicenseSettings = licenseSettings || DEFAULT_LICENSE_SETTINGS;
      const nftMetadata = {
        name: `IP Ownership — ${ipMetadata.title}`,
        description: "Ownership NFT for IP Asset",
        image: imageGateway,
        ipMetadataURI,
        attributes: [
          { trait_type: "ip_metadata_uri", value: ipMetadataURI },
          { trait_type: "Type", value: aiDetection?.isAI ? "AI-generated" : "Original" },
          { trait_type: "License Type", value: usedLicenseSettings.pilType },
          { trait_type: "Commercial Use", value: usedLicenseSettings.commercialUse ? "Yes" : "No" },
          { trait_type: "AI Learning Allowed", value: usedLicenseSettings.aiLearning ? "Yes" : "No" },
          ...(usedLicenseSettings.commercialUse ? [{ trait_type: "Revenue Share", value: `${usedLicenseSettings.revShare}%` }] : []),
          { trait_type: "Territory", value: usedLicenseSettings.territory },
        ],
      };

      // 6. Upload NFT metadata to IPFS
      const nftMetaUpload = await uploadJSON(nftMetadata);
      const nftMetaCid = extractCid(nftMetaUpload.cid || nftMetaUpload.url);
      const nftMetadataURI = toIpfsUri(nftMetaCid);
      const nftMetadataHash = await keccakOfJson(nftMetadata);

      setRegisterState(prev => ({
        ...prev,
        status: 'minting',
        progress: 75
      }));

      // 7. Mint and register IP on Story Protocol with license terms
      const client = await getClient();
      const licenseTermsData = createLicenseTerms(usedLicenseSettings);

      const result = await client.ipAsset.mintAndRegisterIpAssetWithPilTerms({
        spgNftContract: SPG_COLLECTION,
        recipient: address as `0x${string}`,
        licenseTermsData: [licenseTermsData],
        ipMetadata: {
          ipMetadataURI,
          ipMetadataHash,
          nftMetadataURI,
          nftMetadataHash,
        },
        allowDuplicates: true,
      });

      setRegisterState({
        status: 'success',
        progress: 100,
        error: null,
        ipId: result.ipId,
        txHash: result.txHash,
      });

      return {
        success: true,
        ipId: result.ipId,
        txHash: result.txHash,
        imageUrl: imageGateway,
        ipMetadataUrl: toHttps(ipMetaCid),
        nftMetadataUrl: toHttps(nftMetaCid),
        licenseType: usedLicenseSettings.pilType,
        aiDetected: aiDetection?.isAI || false,
        aiConfidence: aiDetection?.confidence || 0,
      };

    } catch (error: any) {
      setRegisterState(prev => ({
        ...prev,
        status: 'error',
        error
      }));

      return {
        success: false,
        error: error?.message || String(error)
      };
    }
  }, [address, getClient, ensureAeneid]);

  const resetRegister = useCallback(() => {
    setRegisterState({
      status: 'idle',
      progress: 0,
      error: null,
    });
  }, []);

  return {
    registerState,
    executeRegister,
    resetRegister,
  };
}
