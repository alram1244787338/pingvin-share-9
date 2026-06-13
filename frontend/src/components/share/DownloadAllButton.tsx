import { Button } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import toast from "../../utils/toast.util";

const DownloadAllButton = ({ shareId }: { shareId: string }) => {
  const [isZipReady, setIsZipReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isShareInvalid, setIsShareInvalid] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const t = useTranslate();

  const downloadAll = async () => {
    if (isShareInvalid) return;
    setIsLoading(true);
    await shareService
      .downloadFile(shareId, "zip")
      .then(() => setIsLoading(false))
      .catch(() => setIsLoading(false));
  };

  useEffect(() => {
    const checkMetaData = () => {
      shareService
        .getMetaData(shareId)
        .then((share) => {
          setIsZipReady(share.isZipReady);
          if (share.isZipReady && timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
        })
        .catch((e) => {
          const status = e.response?.status;
          const error = e.response?.data?.error;
          // If share is removed, not found, or any server error, stop polling
          if (
            status === 404 ||
            error === "share_removed" ||
            (status && status >= 400)
          ) {
            setIsShareInvalid(true);
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
          }
        });
    };

    checkMetaData();

    timerRef.current = setInterval(checkMetaData, 5000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [shareId]);

  if (isShareInvalid) return null;

  return (
    <Button
      variant="outline"
      loading={isLoading}
      disabled={isShareInvalid}
      onClick={() => {
        if (!isZipReady) {
          toast.error(t("share.notify.download-all-preparing"));
        } else {
          downloadAll();
        }
      }}
    >
      <FormattedMessage id="share.button.download-all" />
    </Button>
  );
};

export default DownloadAllButton;
