import { useState, useCallback } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { useStoryClient } from "@/lib/storyClient";
import { compressImage } from "@/lib/utils/image";
import { uploadFile, uploadJSON, extractCid, toHttps, toIpfsUri } from "@/lib/utils/ipfs";
import { sha256HexOfFile, keccakOfJson } from "@/lib/utils/crypto";
import { SPG_COLLECTION_ADDRESS } from "@/lib/constants";
import type { RegisterIntent } from "@/lib/agent/engine";
import type { RegisterState } from "@/types/agents";

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

  const executeRegister = useCallback(async (intent: RegisterIntent, file: File) => {
    try {
      // Validate SPG collection address
      console.log('🔍 SPG Collection Address being used:', SPG_COLLECTION_ADDRESS);
      if (SPG_COLLECTION_ADDRESS === "0xc32A8a0FF3beDDDa58393d022aF433e78739FAbc") {
        console.log('✅ Using correct SPG collection address');
      } else {
        console.warn('⚠️ SPG collection address might be incorrect');
      }

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

      // 3. Create IP metadata
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

      // 5. Create NFT metadata
      const nftMetadata = {
        name: `IP Ownership — ${ipMetadata.title}`,
        description: "Ownership NFT for IP Asset",
        image: imageGateway,
        ipMetadataURI,
        attributes: [{ trait_type: "ip_metadata_uri", value: ipMetadataURI }],
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

      // 7. Mint and register IP on Story Protocol
      console.log('🔍 Using SPG Collection Address:', SPG_COLLECTION_ADDRESS);
      console.log('📝 IP Metadata URI:', ipMetadataURI);
      console.log('🔐 IP Metadata Hash:', ipMetadataHash);
      console.log('📝 NFT Metadata URI:', nftMetadataURI);
      console.log('🔐 NFT Metadata Hash:', nftMetadataHash);

      // Validate metadata before contract call
      if (!ipMetadataURI.startsWith('ipfs://')) {
        throw new Error('Invalid IP metadata URI format');
      }
      if (!nftMetadataURI.startsWith('ipfs://')) {
        throw new Error('Invalid NFT metadata URI format');
      }
      if (!ipMetadataHash.startsWith('0x') || ipMetadataHash.length !== 66) {
        throw new Error('Invalid IP metadata hash format');
      }
      if (!nftMetadataHash.startsWith('0x') || nftMetadataHash.length !== 66) {
        throw new Error('Invalid NFT metadata hash format');
      }

      const client = await getClient();

      try {
        const result = await client.ipAsset.mintAndRegisterIp({
          spgNftContract: SPG_COLLECTION_ADDRESS,
          recipient: address as `0x${string}`,
          ipMetadata: {
            ipMetadataURI,
            ipMetadataHash,
            nftMetadataURI,
            nftMetadataHash,
          },
          allowDuplicates: true,
        });

        console.log('✅ Registration successful:', result);

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
        };
      } catch (contractError: any) {
        console.error('❌ Contract Error Details:', {
          message: contractError.message,
          cause: contractError.cause,
          details: contractError.details,
          spgContract: SPG_COLLECTION_ADDRESS,
          recipient: address,
        });

        // Provide more specific error messages
        if (contractError.message?.includes('execution reverted')) {
          throw new Error(
            `Contract execution failed. This could be due to:\n` +
            `• Invalid metadata format\n` +
            `• Insufficient gas\n` +
            `• Wrong SPG collection address\n` +
            `• Network issues\n\n` +
            `Using SPG: ${SPG_COLLECTION_ADDRESS}\n` +
            `Original error: ${contractError.message}`
          );
        }

        throw contractError;
      }

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
